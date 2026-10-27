/** Developer tooling must not initialize the application's database/auth environment. */
export function diagnostic(message: unknown): void {
  console.warn(message);
}
