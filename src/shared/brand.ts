declare const brand: unique symbol;
/** Nominal type: a plain string is not assignable to Brand<string, 'CardId'>. */
export type Brand<T, B extends string> = T & { readonly [brand]: B };
