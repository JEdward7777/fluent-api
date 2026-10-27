import canonicalize from 'canonicalize';
import { createHash } from 'node:crypto';

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** RFC 8785/JCS, shared by request identity and deterministic classification evidence. */
export function hashCanonicalJson(value: JsonValue): string {
  const serialized = canonicalize(value);
  if (serialized === undefined) throw new Error('Canonical JSON requires a JSON value');
  return createHash('sha256').update(serialized).digest('hex');
}
