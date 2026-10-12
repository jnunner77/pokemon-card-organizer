/* The Table's filter expressions: a line like
     set = "30th Celebration" and not owner in (Megan, Both) and (value > 10 or grader != Raw)
   read into a tree, tested against each card, with suggestions for the editor as you type.

   A comparison is a column, an operator and a value:
     =  !=     is (or isn't) the value: the cell as shown, what's stored, or its filter group
               (owner = "Not set", status = sold, location = "Binder 1", released = 2026)
     ~  !~     contains (or doesn't) the value; : works like ~ (name:pika)
     > >= < <= compares numbers (value, paid, grade, a card number's first digits), release dates
               by as much as you give (released >= 2024-06), and other text alphabetically
     in (a, b) any of the values; not in (a, b) none of them
     is blank, is not blank
   Join them with and (or just a space), or, not (or !), and ( ). A word on its own (pikachu, or
   "full art" in quotes) matches cards with it in the name, set, number, rarity, variant, illustrator,
   grade, owner or notes. Columns go by their key or their heading (set code, setCode and code are
   the same; quotes aren't needed), ignoring case and accents, like the values.

   ctx is the Table's (see table.js). A plain script loaded after table.js: the page uses
   window.BinderExpr, and the tests load it the same way. */
(function (root) {
  "use strict";

  const T = root.BinderTable;
  const { BY, COLUMNS, norm } = T;
  const squash = s => norm(s).replace(/[^a-z0-9]/g, "");

  /* the words that name a column: its key, its heading, and a few more */
  const ALIAS = {
    card: "name", code: "setCode", no: "number", num: "number", stamp: "variant", lang: "language", cond: "condition",
    graded: "grader", gradedby: "grader", illustrator: "artist", note: "notes", loc: "location", binder: "location",
    year: "released", release: "released", date: "released", price: "value", worth: "value", cost: "paid",
    pricematch: "match", photo: "picture", image: "picture", pic: "picture",
  };
  const FIELD = {};
  for (const c of COLUMNS) { FIELD[squash(c.k)] = c.k; FIELD[squash(c.h)] = c.k; }
  for (const [a, k] of Object.entries(ALIAS)) FIELD[a] = k;
  const fieldOf = w => FIELD[squash(w)] || null;
  /* how the editor writes a column */
  const NAME = { setCode: "setcode" };
  const fieldName = k => NAME[k] || k;

  const SEARCH = ["name", "set", "setCode", "number", "rarity", "variant", "artist", "grade", "owner", "notes"];
  const CMP = ["=", "!=", "~", "!~", ">", ">=", "<", "<="];
  const WORDS = new Set(["and", "or", "not", "in", "is", "blank", "empty"]);

  /* ---------- reading ---------- */

  /* the line as tokens: {t: word|str|op|(|)|,, v, at, end}; an unclosed quote is an error unless loose */
  function tokens(src, loose) {
    const out = [];
    let i = 0;
    while (i < src.length) {
      const ch = src[i];
      if (/\s/.test(ch)) { i++; continue; }
      const at = i;
      if (ch === "(" || ch === ")" || ch === ",") { out.push({ t: ch, v: ch, at, end: ++i }); continue; }
      if (ch === '"' || ch === "'") {
        let v = ""; i++;
        while (i < src.length && src[i] !== ch) { if (src[i] === "\\" && i + 1 < src.length) i++; v += src[i++]; }
        if (i >= src.length) {
          if (!loose) throw fail(`This quote isn't closed: add a ${ch} at the end of the value.`, at, src.length);
          out.push({ t: "str", v, at, end: i, open: true }); continue;
        }
        out.push({ t: "str", v, at, end: ++i }); continue;
      }
      const two = src.slice(i, i + 2);
      if (["!=", "!~", ">=", "<=", "==", "&&", "||"].includes(two)) {
        i += 2; out.push({ t: "op", v: two === "==" ? "=" : two === "&&" ? "and" : two === "||" ? "or" : two, at, end: i }); continue;
      }
      if ("=~:<>!".includes(ch)) { i++; out.push({ t: "op", v: ch === ":" ? "~" : ch === "!" ? "not" : ch, at, end: i }); continue; }
      while (i < src.length && !/[\s()=~:<>,"]/.test(src[i]) && !(src[i] === "!" && "=~".includes(src[i + 1] || ""))) i++;
      out.push({ t: "word", v: src.slice(at, i), at, end: i });
    }
    return out;
  }
  function fail(error, at, end) { const e = new Error(error); e.at = at; e.end = end; return e; }
  const kw = (tok, w) => !!tok && ((tok.t === "word" && tok.v.toLowerCase() === w) || (tok.t === "op" && tok.v === w));

  /* the expression as a tree: {ast} (null when blank), or {error, at, end} pointing at the problem */
  function parse(src) {
    src = String(src ?? "");
    let toks;
    try { toks = tokens(src); } catch (e) { return { error: e.message, at: e.at, end: e.end }; }
    let p = 0;
    const peek = (o = 0) => toks[p + o];
    const here = () => (peek() ? [peek().at, peek().end] : [src.length, src.length]);
    const want = msg => { const [a, b] = here(); return fail(msg, a, b); };

    function or() {
      const xs = [and()];
      while (kw(peek(), "or")) { const t = toks[p++]; if (!peek()) throw fail("Something has to come after or.", t.at, t.end); xs.push(and()); }
      return xs.length > 1 ? { type: "or", xs } : xs[0];
    }
    function and() {
      const xs = [unary()];
      for (;;) {
        const t = peek();
        if (kw(t, "and")) { p++; if (!peek()) throw fail("Something has to come after and.", t.at, t.end); xs.push(unary()); continue; }
        if (t && t.t !== ")" && !kw(t, "or")) { xs.push(unary()); continue; } // a space is and
        break;
      }
      return xs.length > 1 ? { type: "and", xs } : xs[0];
    }
    function unary() {
      const t = peek();
      if (kw(t, "not")) { p++; if (!peek()) throw fail("Something has to come after not.", t.at, t.end); return { type: "not", x: unary() }; }
      return primary();
    }
    function primary() {
      const t = peek();
      if (!t) throw want("Something is missing at the end.");
      if (t.t === "(") {
        p++;
        if (peek() && peek().t === ")") throw want("There's nothing between these brackets.");
        const x = or();
        if (!peek() || peek().t !== ")") throw fail("This ( isn't closed: add a ) after what it groups.", t.at, t.end);
        p++; return x;
      }
      if (t.t === ")") throw want("This ) doesn't close anything.");
      if (t.t === ",") throw want("A comma only goes between the values in in ( … ).");
      if (t.t === "op") throw want(`${t.v} needs a column before it, like value ${t.v} 10.`);
      if (kw(t, "and") || kw(t, "or")) throw want(`Something has to come before ${t.v}.`);
      const next = peek(1), cmp = next && next.t === "op" && CMP.includes(next.v);
      const isIn = kw(next, "in") || (kw(next, "not") && kw(peek(2), "in")), isIs = kw(next, "is");
      if (t.t === "word" && (cmp || isIn || isIs)) {
        const k = fieldOf(t.v);
        if (!k) throw fail(`There's no column called ${t.v}. Try ${["name", "set", "owner", "value", "status"].join(", ")}…`, t.at, t.end);
        p++;
        if (cmp) {
          const op = toks[p++], v = peek();
          if (!v || (v.t !== "word" && v.t !== "str") || (v.t === "word" && (kw(v, "and") || kw(v, "or")))) throw fail(`What should ${t.v} be compared with? Put a value after ${op.v}.`, op.at, op.end);
          p++;
          return { type: "cmp", k, op: op.v, v: v.v, at: t.at, end: v.end };
        }
        if (isIs) {
          const is = toks[p++], neg = kw(peek(), "not"); if (neg) p++;
          const b = peek();
          if (!kw(b, "blank") && !kw(b, "empty")) throw fail(`is goes with blank: ${t.v} is blank, or ${t.v} is not blank.`, is.at, (b || is).end);
          p++;
          return { type: "blank", k, neg, at: t.at, end: b.end };
        }
        const neg = kw(peek(), "not"); if (neg) p++;
        const inTok = toks[p++];
        if (!peek() || peek().t !== "(") throw fail(`in takes a list in brackets, like ${t.v} in (a, b).`, inTok.at, inTok.end);
        const open = toks[p++], vs = [];
        for (;;) {
          const v = peek();
          if (!v) throw fail("This list isn't closed: add a ) after the last value.", open.at, open.end);
          if (v.t === ")" && vs.length) { p++; break; }
          if (v.t !== "word" && v.t !== "str") throw want("Put a value here; values are separated by commas.");
          vs.push(v.v); p++;
          if (peek() && peek().t === ",") { p++; continue; }
          if (peek() && peek().t !== ")") throw want("Values in the list are separated by commas.");
        }
        return { type: "in", k, neg, vs, at: t.at, end: toks[p - 1].end };
      }
      p++;
      return { type: "text", v: t.v, at: t.at, end: t.end };
    }

    try {
      if (!toks.length) return { ast: null };
      const ast = or();
      if (p < toks.length) {
        const t = peek();
        throw fail(t.t === ")" ? "This ) doesn't close anything." : `Didn't expect ${t.v} here.`, t.at, t.end);
      }
      return { ast };
    } catch (e) { return { error: e.message, at: e.at ?? 0, end: e.end ?? src.length }; }
  }

  /* ---------- testing a card ---------- */

  const NUM = /^[-+]?\$?\d[\d,]*(?:\.\d+)?$/;
  const toNum = s => Number(String(s).replace(/[$,+]/g, ""));
  const lead = s => { const m = String(s ?? "").trim().match(/^\$?(\d+(?:\.\d+)?)/); return m ? Number(m[1]) : null; };

  /* what a card has in a column: the stored or worked-out value, how it reads, and its filter group */
  function cell(c, k, ctx) {
    const col = BY[k], v = T.raw(c, col, ctx), label = T.label(col, v, ctx);
    return { col, v, label, empty: v == null || String(v).trim() === "", forms: [v, label, T.group(c, col, ctx)].map(norm) };
  }
  const yes = q => ({ true: "yes", false: "no", y: "yes", n: "no" }[q] || q);

  function is(x, q) {
    q = norm(q);
    if (q === "") return x.empty;
    if (x.col.num) return !x.empty && NUM.test(q) && Math.abs(Number(x.v) - toNum(q)) < 0.005;
    if (x.col.edit === "bool") q = yes(q);
    return x.forms.includes(q);
  }
  function has(x, q) { q = norm(q); return q === "" || x.forms.some(f => f.includes(q)); }
  function order(x, op, q) {
    if (x.empty) return false;
    let r;
    if (NUM.test(q) && (x.col.num || lead(x.v) != null)) r = (x.col.num ? Number(x.v) : lead(x.v)) - toNum(q);
    else if (x.col.k === "released") { const s = String(x.v); r = s.slice(0, q.length) < q ? -1 : s.slice(0, q.length) > q ? 1 : 0; }
    else r = T.cmp(x.label, q);
    return { ">": r > 0, ">=": r >= 0, "<": r < 0, "<=": r <= 0 }[op];
  }

  /* does the card match the tree? (no tree: every card does) */
  function test(ast, c, ctx) {
    if (!ast) return true;
    switch (ast.type) {
      case "and": return ast.xs.every(x => test(x, c, ctx));
      case "or": return ast.xs.some(x => test(x, c, ctx));
      case "not": return !test(ast.x, c, ctx);
      case "text": { const q = norm(ast.v); return SEARCH.some(k => cell(c, k, ctx).forms[1].includes(q)); }
      case "blank": return cell(c, ast.k, ctx).empty !== ast.neg;
      case "in": { const x = cell(c, ast.k, ctx); return ast.vs.some(v => is(x, v)) !== ast.neg; }
      case "cmp": {
        const x = cell(c, ast.k, ctx);
        switch (ast.op) {
          case "=": return is(x, ast.v);
          case "!=": return !is(x, ast.v);
          case "~": return has(x, ast.v);
          case "!~": return !has(x, ast.v);
          default: return order(x, ast.op, ast.v);
        }
      }
    }
    return true;
  }

  /* ---------- writing ---------- */

  /* a value as the editor writes it: bare when it can be, quoted otherwise */
  function quote(v) {
    v = String(v ?? "");
    if (/^[\p{L}\p{N}_.\-$/#+]+$/u.test(v) && !WORDS.has(v.toLowerCase())) return v;
    return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }

  /* the Table's header filters written as one expression ("" when there are none) */
  function fromFilters(filters) {
    const parts = [];
    for (const [k, f] of T.active(filters)) {
      const col = BY[k], name = fieldName(k);
      if (col.filter === "pick") {
        const vals = f.in.filter(v => v !== ""), blank = vals.length < f.in.length;
        const opts = [];
        if (blank) opts.push(`${name} is blank`);
        if (vals.length === 1) opts.push(`${name} = ${quote(vals[0])}`);
        else if (vals.length) opts.push(`${name} in (${vals.map(quote).join(", ")})`);
        const one = opts.length > 1 ? `(${opts.join(" or ")})` : opts[0];
        parts.push(f.not ? (opts.length > 1 ? `not ${one}` : one.replace(/ is blank$/, " is not blank").replace(/ = /, " != ").replace(/ in \(/, " not in (")) : one);
        continue;
      }
      const not = f.startsWith("!"), q = not ? f.slice(1) : f, nq = norm(q);
      let e;
      if (nq === T.BLANK || nq === T.FILLED) {
        e = `${name} is ${(nq === T.FILLED) !== not ? "not " : ""}blank`;
        parts.push(e); continue;
      }
      const s = q.replace(/[$,\s]/g, "");
      let m;
      if (col.filter === "num" && T.numTest(q) && (m = s.match(/^(>=|<=|>|<|=)?(\d+(?:\.\d+)?)$/))) e = `${name} ${m[1] || "="} ${m[2]}`;
      else if (col.filter === "num" && T.numTest(q) && (m = s.match(/^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/))) {
        const lo = Math.min(+m[1], +m[2]), hi = Math.max(+m[1], +m[2]);
        e = `(${name} >= ${lo} and ${name} <= ${hi})`;
      } else e = `${name} ~ ${quote(q.trim())}`;
      // a turned-around filter keeps the cards with no value, so > and < get a not rather than flipping
      parts.push(!not ? e : / (~|=) /.test(e) && !e.startsWith("(") ? e.replace(/ ~ /, " !~ ").replace(/ = /, " != ") : `not ${e}`);
    }
    return parts.join(" and ");
  }

  /* ---------- suggestions ---------- */

  /* the values the cards have in a column, most common first: [{v, label, n}] */
  function values(cards, k, ctx) {
    const col = BY[k];
    if (col.num) return [];
    if (col.filter === "pick") return T.choices(cards, col, ctx).filter(x => x.v !== "").sort((a, b) => b.n - a.n);
    const n = new Map();
    for (const c of cards) { const v = T.label(col, T.raw(c, col, ctx), ctx); if (v && v.length <= 60) n.set(v, (n.get(v) || 0) + 1); }
    return [...n].map(([v, m]) => ({ v, label: v, n: m })).sort((a, b) => b.n - a.n || T.cmp(a.v, b.v));
  }
  const OPS = [
    { v: "=", hint: "is" }, { v: "!=", hint: "isn't" }, { v: "~", hint: "contains" }, { v: "!~", hint: "doesn't contain" },
    { v: ">", hint: "more than" }, { v: ">=", hint: "at least" }, { v: "<", hint: "less than" }, { v: "<=", hint: "at most" },
    { v: "in (", hint: "any of" }, { v: "not in (", hint: "none of" }, { v: "is blank", hint: "empty" }, { v: "is not blank", hint: "filled in" },
  ];
  /* which operators make sense for a column */
  function opsFor(k) {
    const col = BY[k];
    const ord = col.num || ["released", "grade", "number"].includes(k);
    return OPS.filter(o => (ord || ![">", ">=", "<", "<="].includes(o.v)) && (col.filter !== "pick" || col.edit === "select" || !["~", "!~"].includes(o.v) || k === "location" || k === "match"));
  }
  const fieldItems = () => COLUMNS.map(c => ({ label: fieldName(c.k), insert: fieldName(c.k) + " ", hint: c.h }));

  /* what could go at the caret: {from, to, kind, items: [{label, insert, hint}]}; from–to is replaced */
  function suggest(src, caret, cards, ctx) {
    src = String(src ?? ""); caret = caret == null ? src.length : caret;
    const toks = tokens(src.slice(0, caret), true), last = toks[toks.length - 1];
    let from = caret, part = "", opPart = false;
    if (last && last.end === caret && (last.t === "word" || last.t === "str")) { from = last.at; part = last.v; toks.pop(); }
    else if (last && last.end === caret && last.t === "op" && CMP.includes(last.v)) { from = last.at; opPart = true; toks.pop(); }
    const prev = toks[toks.length - 1], prev2 = toks[toks.length - 2];
    const spaced = from < caret || /\s$/.test(src.slice(0, caret));

    // the column whose in ( … ) list the caret is in
    let depth = 0, inField = null;
    for (let i = toks.length - 1; i >= 0; i--) {
      const t = toks[i];
      if (t.t === ")") depth++;
      else if (t.t === "(") {
        if (depth) { depth--; continue; }
        if (kw(toks[i - 1], "in")) { const f = kw(toks[i - 2], "not") ? toks[i - 3] : toks[i - 2]; inField = f && f.t === "word" ? fieldOf(f.v) : null; }
        break;
      }
    }
    const afterOp = !opPart && prev && prev.t === "op" && CMP.includes(prev.v) && prev2 && prev2.t === "word" ? fieldOf(prev2.v) : null;
    const fieldBefore = prev && prev.t === "word" && fieldOf(prev.v) && !(prev2 && prev2.t === "op" && CMP.includes(prev2.v)) && !kw(prev2, "is") && !kw(prev2, "in");

    let items, kind;
    if (inField && prev && (prev.t === "(" || prev.t === ",")) {
      kind = "value"; items = values(cards, inField, ctx).map(x => ({ label: x.label, insert: quote(x.v), hint: String(x.n) }));
    } else if (inField && prev && (prev.t === "word" || prev.t === "str") && !part) {
      kind = "join"; items = [{ label: ",", insert: ", ", hint: "another value" }, { label: ")", insert: ") ", hint: "end the list" }];
    } else if (afterOp) {
      kind = "value"; items = values(cards, afterOp, ctx).map(x => ({ label: x.label, insert: quote(x.v) + " ", hint: String(x.n) }));
    } else if (fieldBefore && (opPart || (!part && spaced))) {
      kind = "op"; items = opsFor(fieldOf(prev.v)).map(o => ({ label: o.v, insert: o.v + (o.v.endsWith("(") ? "" : " "), hint: o.hint }));
      if (opPart) items = items.filter(o => o.label.startsWith(last.v));
    } else if (kw(prev, "is") || (kw(prev, "not") && kw(prev2, "is"))) {
      kind = "op"; items = (kw(prev, "is") ? ["blank", "not blank"] : ["blank"]).map(v => ({ label: v, insert: v + " ", hint: "" }));
    } else if (!part && prev && (prev.t === "str" || prev.t === ")" || (prev.t === "word" && !["and", "or", "not"].some(w => kw(prev, w))))) {
      kind = "join"; items = [{ label: "and", insert: "and ", hint: "both" }, { label: "or", insert: "or ", hint: "either" }];
      if (toks.filter(t => t.t === "(").length > toks.filter(t => t.t === ")").length) items.push({ label: ")", insert: ") ", hint: "close the bracket" });
    } else {
      kind = "field"; items = fieldItems();
      if (!part) items.push({ label: "not", insert: "not ", hint: "the opposite of what follows" }, { label: "(", insert: "(", hint: "a group" });
    }
    if (part) {
      const q = norm(part), l = x => norm(x.label);
      items = [...items.filter(x => l(x).startsWith(q)), ...items.filter(x => !l(x).startsWith(q) && l(x).includes(q))];
    }
    return { from, to: caret, kind, items: items.slice(0, 30) };
  }

  root.BinderExpr = { parse, test, quote, fromFilters, suggest, values, opsFor, fieldOf, fieldName, SEARCH };
})(typeof window !== "undefined" ? window : globalThis);
