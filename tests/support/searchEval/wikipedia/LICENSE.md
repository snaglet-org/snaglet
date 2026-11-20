# License of the Wikipedia text in this folder

The Wikipedia text in this folder is not covered by Snaglet's MIT License. It is
by Wikipedia contributors and licensed under
[Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0)](https://creativecommons.org/licenses/by-sa/4.0/).
If you share a modified version of it, the ShareAlike term applies.

This covers:

- `source-response.json`: the introductory extracts exactly as returned by the
  Wikipedia API request in `source-request.txt`.
- `corpus.json`: each document's `content`, adapted from those extracts. Each
  document's `source.adaptation` and `attributionNote` fields record the
  changes: plain-text introduction only (markup, references and images
  removed), some introductory paragraphs omitted, paragraph spacing
  normalized, retained text not rewritten.
- `queries.json`: the `evidence` quotations taken from those excerpts.

Everything else here (the TypeScript files, `README.md`, the JSON structure and
metadata, and the authored queries and rationales in `queries.json`) is Snaglet's own
work under the MIT License.

## Sources

| Article                                                                | Page ID  | Revision                                                            | Introductory paragraphs kept |
| ---------------------------------------------------------------------- | -------- | ------------------------------------------------------------------- | ---------------------------- |
| [Arch bridge](https://en.wikipedia.org/wiki/Arch_bridge)               | 318272   | [1378381818](https://en.wikipedia.org/w/index.php?oldid=1378381818) | 1 of 1                       |
| [Engineering](https://en.wikipedia.org/wiki/Engineering)               | 9251     | [1371876710](https://en.wikipedia.org/w/index.php?oldid=1371876710) | 1, 2, 4 of 4                 |
| [Fermentation](https://en.wikipedia.org/wiki/Fermentation)             | 6073894  | [1374781336](https://en.wikipedia.org/w/index.php?oldid=1374781336) | 1, 2, 3 of 3                 |
| [Mercury (element)](<https://en.wikipedia.org/wiki/Mercury_(element)>) | 18617142 | [1380113040](https://en.wikipedia.org/w/index.php?oldid=1380113040) | 1, 2, 3 of 3                 |
| [Mercury (planet)](<https://en.wikipedia.org/wiki/Mercury_(planet)>)   | 19694    | [1379349287](https://en.wikipedia.org/w/index.php?oldid=1379349287) | 1, 2 of 4                    |
| [Pollination](https://en.wikipedia.org/wiki/Pollination)               | 233609   | [1378314619](https://en.wikipedia.org/w/index.php?oldid=1378314619) | 1, 2 of 4                    |
| [Printing press](https://en.wikipedia.org/wiki/Printing_press)         | 23295    | [1379445153](https://en.wikipedia.org/w/index.php?oldid=1379445153) | 1, 2, 3 of 3                 |
| [Sonata](https://en.wikipedia.org/wiki/Sonata)                         | 44118    | [1379581605](https://en.wikipedia.org/w/index.php?oldid=1379581605) | 1, 2 of 2                    |

Page IDs, revision IDs and URLs are the `source` fields in `corpus.json`, which
match `pageid`, `lastrevid` and `fullurl` in `source-response.json`. Do not edit
the data files to change attribution: a unit test checks the SHA-256 of
`source-response.json`.
