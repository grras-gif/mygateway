/** Marks platform-provided bindings that are only fail-fast placeholders. */
const UNAVAILABLE = new WeakSet<object>();

export function markBindingUnavailable(binding: object): void {
  UNAVAILABLE.add(binding);
}

export function isBindingUnavailable(binding: unknown): boolean {
  return typeof binding === 'object' && binding !== null && UNAVAILABLE.has(binding as object);
}
