import assert from 'node:assert/strict';
import net from 'node:net';
import { after, describe, it } from 'node:test';
import { MailRefused, MailUnavailable } from '#application/alerts/ports.ts';
import { headerText, mimeMessage, SmtpMailer } from '#infrastructure/alerts/smtp-mailer.ts';

const ACCOUNT = { address: 'me@gmail.com', password: 'abcdefghijklmnop' };
const MESSAGE = { to: ['me@gmail.com', 'b@x.ca'], subject: 'Buy alert: Pokémon at $4.50', text: 'Hello\n.dot line', html: '<p>Hello</p>' };

/** A fake SMTP server: answers each command as `answer` says, and keeps what it was sent. */
function fakeServer(answer: (command: string) => string | null = () => null) {
  const commands: string[] = [];
  let data = '';
  const servers: net.Server[] = [];
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    socket.write('220 smtp.example.com ready\r\n');
    let inData = false;
    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (inData) {
        const end = buffer.indexOf('\r\n.\r\n');
        if (end < 0) return;
        data = buffer.slice(0, end);
        buffer = buffer.slice(end + 5);
        inData = false;
        socket.write('250 2.0.0 OK queued\r\n');
      }
      let at: number;
      while (!inData && (at = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        commands.push(line);
        const custom = answer(line);
        if (custom !== null) {
          if (custom) socket.write(custom);
          continue;
        }
        if (line.startsWith('EHLO')) socket.write('250-smtp.example.com\r\n250-AUTH PLAIN LOGIN\r\n250 SMTPUTF8\r\n');
        else if (line.startsWith('AUTH')) socket.write('235 2.7.0 Accepted\r\n');
        else if (line === 'DATA') {
          inData = true;
          socket.write('354 Go ahead\r\n');
        } else if (line === 'QUIT') socket.end('221 2.0.0 closing\r\n');
        else socket.write('250 2.1.0 OK\r\n');
      }
    });
  });
  servers.push(server);
  return new Promise<{ port: number; commands: string[]; data: () => string; close: () => void }>((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ port: typeof address === 'object' && address ? address.port : 0, commands, data: () => data, close: () => server.close() });
    }),
  );
}

const closers: (() => void)[] = [];
after(() => closers.forEach((c) => c()));
const mailer = (port: number, timeoutMs = 2000) => new SmtpMailer({ host: '127.0.0.1', port, secure: false, timeoutMs });

describe('Sending email through Gmail (SMTP)', () => {
  it('signs in with the app password and sends one message with plain-text and HTML parts', async () => {
    const s = await fakeServer();
    closers.push(s.close);
    await mailer(s.port).send(ACCOUNT, MESSAGE);
    assert.deepEqual(s.commands, ['EHLO binder', `AUTH PLAIN ${Buffer.from('\0me@gmail.com\0abcdefghijklmnop').toString('base64')}`, 'MAIL FROM:<me@gmail.com>', 'RCPT TO:<me@gmail.com>', 'RCPT TO:<b@x.ca>', 'DATA', 'QUIT']);
    const data = s.data();
    assert.match(data, /^From: =\?UTF-8\?B\?/m);
    assert.match(data, /^To: me@gmail.com, b@x.ca$/m);
    assert.match(data, /^Subject: =\?UTF-8\?B\?/m);
    assert.match(data, /Content-Type: multipart\/alternative/);
    const parts = [...data.matchAll(/base64\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n--/g)].map((m) => Buffer.from((m[1] ?? '').replace(/\r\n/g, ''), 'base64').toString());
    assert.deepEqual(parts, ['Hello\n.dot line', '<p>Hello</p>']);
  });

  it('says Gmail refused the sign-in', async () => {
    const s = await fakeServer((c) => (c.startsWith('AUTH') ? '535-5.7.8 Username and Password not accepted.\r\n535 5.7.8 Learn more\r\n' : null));
    closers.push(s.close);
    await assert.rejects(mailer(s.port).send(ACCOUNT, MESSAGE), (e: unknown) => e instanceof MailRefused && /^535 5\.7\.8 Username and Password not accepted\. 5\.7\.8 Learn more$/.test(e.message));
  });

  it('fails when the server refuses a step, can\'t be reached, or stops answering', async () => {
    const refusing = await fakeServer((c) => (c.startsWith('RCPT') ? '550 5.1.1 No such user\r\n' : null));
    closers.push(refusing.close);
    await assert.rejects(mailer(refusing.port).send(ACCOUNT, MESSAGE), (e: unknown) => e instanceof MailUnavailable && /refused me@gmail\.com: 550/.test(e.message));
    const silent = await fakeServer((c) => (c.startsWith('EHLO') ? '' : null));
    closers.push(silent.close);
    await assert.rejects(mailer(silent.port, 200).send(ACCOUNT, MESSAGE), (e: unknown) => e instanceof MailUnavailable && /took too long/.test(e.message));
    const gone = await fakeServer();
    gone.close();
    await assert.rejects(mailer(gone.port).send(ACCOUNT, MESSAGE), (e: unknown) => e instanceof MailUnavailable && /Couldn't reach/.test(e.message));
  });
});

describe('The message', () => {
  it('encodes headers that aren\'t plain ASCII, and never lets a line break into one', () => {
    assert.equal(headerText('Buy alert: 2 cards'), 'Buy alert: 2 cards');
    assert.equal(headerText('a\r\nBcc: x@y.z'), 'a Bcc: x@y.z');
    const long = headerText('Pokémon '.repeat(20));
    assert.ok(long.split('\r\n ').every((w) => w.length <= 75 && /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/.test(w)));
    assert.equal(
      long
        .split('\r\n ')
        .map((w) => Buffer.from(w.slice(10, -2), 'base64').toString())
        .join(''),
      'Pokémon '.repeat(20).trimEnd() + ' ',
    );
  });

  it('has a date and an id', () => {
    const m = mimeMessage('me@gmail.com', 'Binder', MESSAGE, new Date('2026-10-20T13:00:00Z'), 'abc');
    assert.match(m, /^Date: Tue, 20 Oct 2026 13:00:00 \+0000$/m);
    assert.match(m, /^Message-ID: <abc@gmail\.com>$/m);
  });
});
