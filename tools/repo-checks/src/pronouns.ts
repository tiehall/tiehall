// The repository refers to people as they and them, never with a gendered
// pronoun: the people in tests, docs and comments, Ada and Bob alike, are
// anyone. The check reads the TypeScript and Markdown files outside openspec/
// and the tests' fixtures, the committed ones and the new ones git does not
// ignore, and names every gendered pronoun it finds, by line.

/**
 * The gendered pronouns, as whole words in any case: the subject, object and
 * possessive forms and the reflexive ones. The pattern is spelled so that this
 * file holds none of them as a word.
 */
const PRONOUN = /\b(?:h(?:e|is|im(?:self)?|er(?:s|self)?)|s(?:h)e)\b/gi;

export interface PronounProblem {
  file: string;
  line: number;
  word: string;
}

/** Whether the check reads the file: TypeScript or Markdown, outside openspec/ and fixtures. */
export function isChecked(file: string): boolean {
  return /\.(?:ts|tsx|md)$/.test(file) && !file.startsWith("openspec/") && !file.split("/").includes("fixtures");
}

/** Every gendered pronoun in the text, by line. */
export function pronounProblems(file: string, text: string): PronounProblem[] {
  return text.split("\n").flatMap((content, index) => [...content.matchAll(PRONOUN)].map(([word]) => ({ file, line: index + 1, word })));
}
