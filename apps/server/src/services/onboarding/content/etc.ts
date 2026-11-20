import type { OnboardingDocSource } from './types';

/** The "etc" folder inside the Onboarding folder, in sidebar order. */
export const ETC_DOCS: readonly OnboardingDocSource[] = [
  {
    slug: 'em-dash-propaganda',
    title: 'The Em Dash Propaganda',
    folder: 'etc',
    body: `# The Em Dash Propaganda

*A statement from a lifelong em dash gal.*

Somewhere along the way, the internet decided that the em dash — this beautiful, long, confident line — is proof that a robot wrote your sentence.

We reject this.

## The facts

- **The em dash is older than your grandma's grandma.** Laurence Sterne filled *Tristram Shandy* with dashes in 1759. Emily Dickinson used them like punctuation was going out of style — and it wasn't.
- **LLMs learned it from us.** They didn't invent the em dash — they read millions of humans who loved it. They have good taste. That's the whole story.
- **It does something no other mark can.** A comma is a pause. A colon is an announcement. An em dash is a *thought turning around mid-sentence to tell you something better.*
- **Stop accusing people of being AI because they used one dash —** Let the em dash live.

## How to type one, proudly

| Where | Keys |
| --- | --- |
| Mac | **Option+Shift+-** |
| Windows | **Alt+0151** (on the number pad) |
| Anywhere | Copy this one: — |
`,
  },
];
