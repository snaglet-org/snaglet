/**
 * Key-prefix guidance — "wrong card" detection.
 *
 * When a credential entered on a provider card fails verification and the key's
 * prefix unmistakably belongs to a different known provider, we enrich the
 * failure message to point the user at the right card. The map is deliberately
 * small and factual — only prefixes distinctive enough to name a provider, and
 * only for providers Snaglet actually ships a card for:
 *
 *   xai-     → xAI (Grok)
 *   sk-ant-  → Anthropic
 *   sk-      → OpenAI-family (ambiguous — OpenAI, DeepSeek, … all use it)
 *
 * The `sk-` prefix is shared by several OpenAI-compatible providers, so it is
 * marked ambiguous and only produces a hint when the card being verified has a
 * distinctive prefix of its own that the key clearly violates (e.g. a bare
 * `sk-` key on the xAI card, which expects `xai-`). This keeps the guidance
 * helpful without second-guessing a plausibly-correct `sk-` key on, say, the
 * DeepSeek card. Naming a card the user cannot open is worse than saying
 * nothing, so only shipped providers appear here.
 */

interface KnownKeyProvider {
  /** Provider id whose card the user should try instead. */
  providerId: string;
  /** Full human label, used in the "this looks like <label> key" clause and the
   * "<label> keys start with …" clause ("xAI (Grok)", "Anthropic", …). */
  label: string;
  /** Short card name for the "Try the <cardName> provider card" clause. Defaults
   * to `label`. */
  cardName?: string;
  /** `a`/`an` for the "this looks like <article> <noun> key" phrasing. */
  article: 'a' | 'an';
  /** Distinctive key prefix(es), most-specific first. */
  prefixes: string[];
  /** True when the prefix is shared across providers (e.g. `sk-`). */
  ambiguous?: boolean;
  /**
   * Noun used in the "this looks like … key" clause when it differs from
   * `label` (e.g. an ambiguous `sk-` key is an "OpenAI-family" key, but the
   * card to try is still "OpenAI").
   */
  familyLabel?: string;
}

// Ordered for readability; prefix matching sorts by length so the most specific
// prefix (sk-ant-) always wins over a shorter one (sk-).
const KNOWN_KEY_PROVIDERS: readonly KnownKeyProvider[] = [
  { providerId: 'xai', label: 'xAI (Grok)', cardName: 'xAI', article: 'an', prefixes: ['xai-'] },
  { providerId: 'anthropic', label: 'Anthropic', article: 'an', prefixes: ['sk-ant-'] },
  {
    providerId: 'openai',
    label: 'OpenAI',
    article: 'an',
    prefixes: ['sk-'],
    ambiguous: true,
    familyLabel: 'OpenAI-family',
  },
];

/** The known provider a key most likely belongs to, by longest prefix match. */
export function detectKeyProvider(secret: string): KnownKeyProvider | null {
  const key = (secret ?? '').trim();
  if (!key) return null;
  const byLength = KNOWN_KEY_PROVIDERS.flatMap((p) =>
    p.prefixes.map((prefix) => ({ prefix, provider: p }))
  ).sort((a, b) => b.prefix.length - a.prefix.length);
  for (const { prefix, provider } of byLength) {
    if (key.startsWith(prefix)) return provider;
  }
  return null;
}

function knownCardFor(providerId: string): KnownKeyProvider | null {
  return KNOWN_KEY_PROVIDERS.find((p) => p.providerId === providerId) ?? null;
}

/**
 * A one-sentence hint when `secret`'s prefix points at a different provider than
 * `cardProviderId`, or null when there's nothing confident to say. Expects an
 * already-normalized (canonical) provider id.
 */
export function keyPrefixHint(cardProviderId: string, secret: string): string | null {
  const detected = detectKeyProvider(secret);
  if (!detected || detected.providerId === cardProviderId) return null;

  const card = knownCardFor(cardProviderId);

  // The key also matches THIS card's own prefix → it looks correct here; the
  // failure is a genuine bad/expired key, not a provider mixup.
  const key = (secret ?? '').trim();
  if (card && card.prefixes.some((p) => key.startsWith(p))) return null;

  // A shared `sk-` prefix only warrants a hint when this card expects a
  // distinctive prefix of its own (so a bare `sk-` key here is clearly wrong).
  if (detected.ambiguous && !card) return null;

  const noun = `${detected.article} ${detected.familyLabel ?? detected.label} key`;
  const cardName = detected.cardName ?? detected.label;
  if (card) {
    return `this looks like ${noun}; ${card.label} keys start with ${card.prefixes[0]}. Try the ${cardName} provider card.`;
  }
  return `this looks like ${noun}. Try the ${cardName} provider card.`;
}

/**
 * Enrich a failed-verification message with key-prefix guidance when the key's
 * prefix belongs to a different provider. No-op when there's nothing to add.
 * Expects an already-normalized provider id.
 */
export function enrichVerifyFailureMessage(
  cardProviderId: string,
  secret: string,
  message: string
): string {
  const hint = keyPrefixHint(cardProviderId, secret);
  if (!hint) return message;
  const base = message && message.trim() ? message.trim() : 'Verification failed';
  return `${base} — ${hint}`;
}
