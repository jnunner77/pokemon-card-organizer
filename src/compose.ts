// Composition root: the only code that knows the concrete classes and wires them together.
// main.ts starts the server with it; tests build apps with it.

export { createApp } from '../server/app.ts';
