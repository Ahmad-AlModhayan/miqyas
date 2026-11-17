// SPDX-License-Identifier: AGPL-3.0-only
// normalize(), the CEL extension that makes text comparable: case, Unicode forms, Arabic diacritics and letter
// variants, and spacing (docs/FOUNDATION.md §4, docs/cel-subset.md). Pure string functions, the same wherever claims
// are evaluated; the shared vectors are test/vectors/normalize.json.

/** Format characters that carry no letter: zero-width and direction marks, the byte order mark, the soft hyphen. */
const INVISIBLE = /[­؜​-‏‪-‮⁠-⁤⁦-⁩﻿]/gu;

/** Arabic tatweel, the vowel and other marks (U+064B to U+065F), the superscript alef, and the Quranic annotation marks. */
const ARABIC_MARKS = /[ـً-ٰٟۖ-ۜ۟-۪ۤۧۨ-ۭ]/gu;

/** The letter variants folded to one letter each. Hamza on waw and on yeh, and the digits, are left as they are. */
const LETTER_VARIANTS: Readonly<Record<string, string>> = {
  'آ': 'ا', // alef with madda above -> alef
  'أ': 'ا', // alef with hamza above -> alef
  'إ': 'ا', // alef with hamza below -> alef
  'ٱ': 'ا', // alef wasla -> alef
  'ى': 'ي', // alef maqsura -> yeh
  'ی': 'ي', // Persian yeh -> yeh
  'ة': 'ه', // teh marbuta -> heh
  'ک': 'ك', // Persian kaf -> kaf
};
const VARIANT = /[آأإٱىیةک]/gu;

/** Unicode White_Space, which `\s` matches; the byte order mark that `\s` also matches is gone by then. */
const SPACE_RUN = /\s+/gu;

/**
 * 1. Unicode form NFKC.
 * 2. Remove invisible format characters.
 * 3. Remove Arabic tatweel and diacritics.
 * 4. Fold Arabic letter variants.
 * 5. Lower case, by the Unicode default mapping and not by locale.
 * 6. NFKC again, so that the result is stable.
 * 7. Every run of white space becomes one space, and the ends are trimmed.
 */
export function normalize(text: string): string {
  return text
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .replace(ARABIC_MARKS, '')
    .replace(VARIANT, (letter) => LETTER_VARIANTS[letter] ?? letter)
    .toLowerCase()
    .normalize('NFKC')
    .replace(SPACE_RUN, ' ')
    .trim();
}
