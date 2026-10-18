// Who may do what: admin (everything, including Administration), editor (changes the ledger),
// viewer (looks only).

/** From least to most allowed. */
export const ROLES = ['viewer', 'editor', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export const isRole = (value: unknown): value is Role => ROLES.some((r) => r === value);

/** Whether `role` may do what `needs` may. */
export const atLeast = (role: Role, needs: Role): boolean => ROLES.indexOf(role) >= ROLES.indexOf(needs);
