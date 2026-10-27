import type { TtsLicenseStatus } from '@/domains/bibles/bibles.types';

import { hashCanonicalJson } from '@/lib/llm/canonical-json';

interface LicenseRule {
  id: string;
  priority: number;
  pattern: RegExp;
  decision: TtsLicenseStatus;
  rationale: string;
}

const rules = [
  {
    id: 'all-rights-reserved',
    priority: 10,
    pattern:
      /(?<![\p{L}\p{N}])(?:all\s+rights\s+reserved|tous\s+droits\s+r[eé]serv[eé]s|todos\s+los\s+derechos\s+reservados|todos\s+os\s+direitos\s+reservados|alle\s+rechte\s+vorbehalten|tutti\s+i\s+diritti\s+riservati|alle\s+rechten\s+voorbehouden|все\s+права\s+защищены)(?![\p{L}\p{N}])/iu,
    decision: 'forbidden',
    rationale: 'The notice explicitly reserves all rights.',
  },
  {
    id: 'creative-commons-or-public-domain',
    priority: 20,
    pattern:
      /(?<![\p{L}\p{N}])(?:creative\s+commons|\bcc[\s-]*(?:by|0)\b|creativecommons\.org\/(?:licenses|publicdomain)|public\s+domain|domaine\s+public|dominio\s+p[uú]blico|gemeinfrei)(?![\p{L}\p{N}])/iu,
    decision: 'allowed',
    rationale: 'The notice identifies a Creative Commons license or public-domain dedication.',
  },
] satisfies LicenseRule[];
rules.sort((left, right) => left.priority - right.priority);

export const LICENSE_RULE_SET_HASH = hashCanonicalJson(
  rules.map(({ pattern, ...rule }) => ({ ...rule, pattern: pattern.source, flags: pattern.flags }))
);

export function matchLicenseRule(notice: string) {
  for (const rule of rules) {
    const match = rule.pattern.exec(notice);
    if (match)
      return {
        id: rule.id,
        priority: rule.priority,
        decision: rule.decision,
        rationale: rule.rationale,
        matchedExcerpt: match[0],
      };
  }
  return null;
}
