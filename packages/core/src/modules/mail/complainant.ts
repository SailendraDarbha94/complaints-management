/**
 * Who complained, as far as a message can say.
 *
 * Lives on its own because three things must agree on it: the card in the tray, the
 * message page that pre-fills the "open a case" form, and openCase() itself. When they
 * each worked it out separately, all three named the Council as the complainant on the
 * first real forward from the office webmail - the unwrapper had not recognised the
 * forward, so the only sender left was registrar@ksdc.in, and every fallback took it.
 *
 * The rule that fixes that for good, whatever the unwrapper misses next: the Council never
 * complains to itself. An address that belongs to the Council - its official address, any
 * address on its own web domain, or the intake mailbox this software reads - is never
 * offered as a complainant. When nothing else is left the answer is "unknown", and the
 * officer is asked, rather than the register being given a wrong party that then gets
 * letters addressed to it.
 */

export interface OwnAddresses {
  /** Whole addresses, lower-cased. */
  addresses: Set<string>;
  /** Domains every address on which is the Council's, lower-cased. */
  domains: Set<string>;
  /**
   * Whether the intake mailbox's own address is among `addresses`. Without it, an office
   * forward addressed to the intake mailbox looks like mail to an outsider, so a rule that
   * reads the To line as "who the Council wrote to" can only be trusted when this is set.
   */
  intakeKnown?: boolean;
}

/**
 * The Council's own addresses, from what the register already knows about it.
 *
 * The domain comes from the Council's WEBSITE, not from its official email. They agree for
 * KSDC (www.ksdc.in, registrar@ksdc.in), but a council whose official address is on
 * gmail.com would otherwise have every complainant on gmail.com refused.
 */
export function ownAddressesOf(council: {
  officialEmail: string | null;
  website: string | null;
  /** The account the intake mailbox is read from, e.g. ksdcregistrarblr@gmail.com. */
  intakeAccount?: string | null;
}): OwnAddresses {
  const addresses = new Set<string>();
  const domains = new Set<string>();

  for (const a of [council.officialEmail, council.intakeAccount]) {
    const clean = a?.trim().toLowerCase();
    if (clean && clean.includes('@')) addresses.add(clean);
  }
  const intake = council.intakeAccount?.trim().toLowerCase();
  const intakeKnown = Boolean(intake && intake.includes('@'));

  const host = council.website
    ?.trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/^www\./, '');
  if (host && host.includes('.')) domains.add(host);

  return { addresses, domains, intakeKnown };
}

/** The account half of a stored mailbox key - see mailboxKey(), which writes "user/folder". */
export function intakeAccountOf(mailbox: string | null | undefined): string | null {
  if (!mailbox) return null;
  const account = mailbox.split('/')[0] ?? '';
  return account.includes('@') ? account : null;
}

/**
 * An address as Gmail delivers it: one mailbox has many spellings there. Dots in the name
 * do not count, anything after a "+" is a tag on the same mailbox, and googlemail.com is
 * gmail.com - so ksdc.registrar.blr@gmail.com and ksdcregistrarblr+intake@googlemail.com
 * both reach ksdcregistrarblr@gmail.com. Every other address is only lower-cased: other
 * providers make no such promise.
 */
export function deliveredAddress(address: string): string {
  const a = address.trim().toLowerCase();
  const at = a.lastIndexOf('@');
  if (at <= 0) return a;
  const domain = a.slice(at + 1);
  if (domain !== 'gmail.com' && domain !== 'googlemail.com') return a;
  const local = a.slice(0, at).split('+')[0]!.replace(/\./g, '');
  return local ? `${local}@gmail.com` : a;
}

export function isOwnAddress(address: string | null | undefined, own: OwnAddresses): boolean {
  const a = address?.trim().toLowerCase();
  if (!a) return false;
  if (own.addresses.has(a)) return true;
  // The intake mailbox under another spelling of the same Gmail account: the office writes
  // it as it likes, and Gmail delivers every spelling to the one mailbox. Read as somebody
  // else, an office forward "to" it looked like the Council writing to an outsider.
  const delivered = deliveredAddress(a);
  for (const mine of own.addresses) {
    if (deliveredAddress(mine) === delivered) return true;
  }
  const domain = a.slice(a.lastIndexOf('@') + 1);
  // Subdomains too: mail.ksdc.in is still the Council.
  for (const d of own.domains) {
    if (domain === d || domain.endsWith(`.${d}`)) return true;
  }
  return false;
}

export interface SuggestedComplainant {
  name: string;
  email: string;
}

/**
 * The complainant this message points at, or null when it does not say.
 *
 * The unwrapped original sender first. Failing that, whoever sent the message itself -
 * right for somebody writing to us directly. Never an address of the Council's own.
 *
 * The name travels WITH its address. A forward whose original carried an address but no
 * display name used to borrow the forwarding officer's name from the envelope, which put
 * one person's name against another person's email.
 */
export function suggestedComplainant(
  m: {
    original_from: string | null;
    original_from_name: string | null;
    envelope_from: string;
    envelope_from_name: string | null;
  },
  own: OwnAddresses,
): SuggestedComplainant | null {
  // A forward is never read past its original: if the original sender is the Council
  // itself (a letter of ours, forwarded back), the envelope sender is only the forwarder.
  const [address, name] = m.original_from
    ? [m.original_from, m.original_from_name]
    : [m.envelope_from, m.envelope_from_name];

  if (!address || isOwnAddress(address, own)) return null;
  return {
    name: name?.trim() || address.split('@')[0] || address,
    email: address.toLowerCase(),
  };
}
