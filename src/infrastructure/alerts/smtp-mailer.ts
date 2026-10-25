import { randomBytes } from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import { type MailAccount, type Mailer, type MailMessage, MailRefused, MailUnavailable } from '#application/alerts/ports.ts';

// Email through Gmail's SMTP server with an app password, using only Node's own modules: a TLS
// connection to smtp.gmail.com:465, AUTH PLAIN, one message with a plain-text and an HTML part.
// `secure: false` (a plain connection) is only for tests against a local fake server.

export interface SmtpOptions {
  readonly host?: string;
  readonly port?: number;
  readonly secure?: boolean;
  /** Longest wait for any one answer from the server. */
  readonly timeoutMs?: number;
  /** The sender's name shown in the mail app. */
  readonly fromName?: string;
}

interface Reply {
  readonly code: number;
  readonly text: string;
}

/** Text for a header: as it is when it's plain ASCII, else RFC 2047 encoded words (UTF-8, base64), folded. */
export function headerText(value: string): string {
  const flat = value.replace(/[\r\n]+/g, ' ');
  if (/^[\x20-\x7e]*$/.test(flat)) return flat;
  const words: string[] = [];
  let chunk = '';
  for (const ch of flat) {
    if (Buffer.byteLength(chunk + ch) > 45) {
      words.push(chunk);
      chunk = '';
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w).toString('base64')}?=`).join('\r\n ');
}

const base64Lines = (s: string): string => (Buffer.from(s).toString('base64').match(/.{1,76}/g) ?? []).join('\r\n');

/** The whole message as sent after DATA: headers, a plain-text and an HTML part, dot-stuffed. */
export function mimeMessage(from: string, fromName: string, message: MailMessage, at: Date, id: string): string {
  const boundary = `binder-${id}`;
  const domain = from.split('@')[1] ?? 'localhost';
  const lines = [
    `From: ${headerText(fromName)} <${from}>`,
    `To: ${message.to.join(', ')}`,
    `Subject: ${headerText(message.subject)}`,
    `Date: ${at.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${id}@${domain}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(message.text),
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(message.html),
    `--${boundary}--`,
    '',
  ];
  return lines
    .join('\r\n')
    .split('\r\n')
    .map((l) => (l.startsWith('.') ? `.${l}` : l))
    .join('\r\n');
}

/** Reads the server's replies (multi-line ones joined) from a connection, one at a time. */
class Replies {
  readonly #socket: net.Socket;
  readonly #timeoutMs: number;
  #buffer = '';
  #lines: string[] = [];
  #waiting: { resolve: (r: Reply) => void; reject: (e: Error) => void; timer: NodeJS.Timeout } | null = null;
  #failed: Error | null = null;

  constructor(socket: net.Socket, timeoutMs: number) {
    this.#socket = socket;
    this.#timeoutMs = timeoutMs;
    socket.setEncoding('utf8');
    socket.on('data', (data: string) => {
      this.#buffer += data;
      let at: number;
      while ((at = this.#buffer.indexOf('\n')) >= 0) {
        this.#lines.push(this.#buffer.slice(0, at).replace(/\r$/, ''));
        this.#buffer = this.#buffer.slice(at + 1);
      }
      this.#settle();
    });
    socket.on('error', (error) => this.#fail(new MailUnavailable(`Couldn't reach the mail server: ${error.message}`)));
    socket.on('close', () => this.#fail(new MailUnavailable('The mail server closed the connection')));
  }

  next(): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.#fail(new MailUnavailable('The mail server took too long to answer')), this.#timeoutMs);
      this.#waiting = { resolve, reject, timer };
      this.#settle();
    });
  }

  #reply(): Reply | null {
    const end = this.#lines.findIndex((l) => /^\d{3}(?: |$)/.test(l));
    if (end < 0) return null;
    const lines = this.#lines.splice(0, end + 1);
    return { code: Number(lines[end]?.slice(0, 3)), text: lines.map((l) => l.slice(4)).join(' ').trim() };
  }

  #settle() {
    const w = this.#waiting;
    if (!w) return;
    const reply = this.#reply();
    if (reply) {
      this.#waiting = null;
      clearTimeout(w.timer);
      w.resolve(reply);
    } else if (this.#failed) {
      this.#waiting = null;
      clearTimeout(w.timer);
      w.reject(this.#failed);
    }
  }

  #fail(error: Error) {
    this.#failed ??= error;
    this.#settle();
    this.#socket.destroy();
  }
}

export class SmtpMailer implements Mailer {
  readonly #host: string;
  readonly #port: number;
  readonly #secure: boolean;
  readonly #timeoutMs: number;
  readonly #fromName: string;

  constructor(o: SmtpOptions = {}) {
    this.#host = o.host ?? 'smtp.gmail.com';
    this.#port = o.port ?? 465;
    this.#secure = o.secure ?? true;
    this.#timeoutMs = o.timeoutMs ?? 30_000;
    this.#fromName = o.fromName ?? 'Pokémon Binder';
  }

  async send(account: MailAccount, message: MailMessage): Promise<void> {
    if (!message.to.length) throw new MailUnavailable('No one to send it to');
    const socket = this.#secure ? tls.connect({ host: this.#host, port: this.#port, servername: this.#host }) : net.connect({ host: this.#host, port: this.#port });
    const replies = new Replies(socket, this.#timeoutMs);
    const expect = async (codes: readonly number[], what: string): Promise<Reply> => {
      const reply = await replies.next();
      if (!codes.includes(reply.code)) throw new MailUnavailable(`The mail server refused ${what}: ${reply.code} ${reply.text}`);
      return reply;
    };
    const say = (line: string) => socket.write(`${line}\r\n`);
    try {
      await expect([220], 'the connection');
      say('EHLO binder');
      await expect([250], 'the greeting');
      say(`AUTH PLAIN ${Buffer.from(`\0${account.address}\0${account.password}`).toString('base64')}`);
      const auth = await replies.next();
      if (auth.code === 535 || auth.code === 534) throw new MailRefused(`${auth.code} ${auth.text}`);
      if (auth.code !== 235) throw new MailUnavailable(`The mail server refused the sign-in: ${auth.code} ${auth.text}`);
      say(`MAIL FROM:<${account.address}>`);
      await expect([250], 'the sender');
      for (const to of message.to) {
        say(`RCPT TO:<${to}>`);
        await expect([250, 251], `${to}`);
      }
      say('DATA');
      await expect([354], 'the message');
      socket.write(`${mimeMessage(account.address, this.#fromName, message, new Date(), randomBytes(12).toString('hex'))}\r\n.\r\n`);
      await expect([250], 'the message');
      say('QUIT');
      await replies.next().catch(() => undefined);
    } finally {
      socket.destroy();
    }
  }
}
