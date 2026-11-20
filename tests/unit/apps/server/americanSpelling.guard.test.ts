/**
 * Guard: Snaglet's own code, comments, docs and UI text use American spelling (color, behavior,
 * canceled, center, gray, normalize). Every tracked text file is split into words, camelCase
 * and snake_case included, and each word is checked against the British forms below.
 *
 * The lockfile names third-party packages, applied migrations are frozen, and the Wikipedia
 * search corpus is quoted text, so those are skipped. A word inside a URL is skipped too. The quoted value 'cancelled' is allowed
 * anywhere: it is the stored and wire spelling of automation, calendar event, sign-in and
 * indexing states, and Google Calendar's own event status.
 */
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import path from 'path';

const REPO_ROOT = path.join(__dirname, '../../../..');
const THIS_FILE = 'tests/unit/apps/server/americanSpelling.guard.test.ts';
const SCANNED = /\.(ts|tsx|js|jsx|mjs|cjs|scss|css|md|rs|swift|json|ya?ml|html|sh|toml|sql)$/;
const SKIPPED = [
  'pnpm-lock.yaml',
  'packages/db/migrations/',
  'tests/support/searchEval/wikipedia/',
  THIS_FILE,
];

const either = (words: string): string => `(?:${words.trim().split(/\s+/).join('|')})`;

const OUR = either(`colour behaviour honour neighbour favour flavour harbour labour rumour humour
  vapour armour endeavour savour odour rigour vigour valour parlour splendour clamour tumour
  candour ardour fervour`);
const ISE_STEMS = either(`custom organ initial normal recogn serial synchron summar priorit author
  token final util visual optim minim maxim sanit capital parameter parametr material emphas penal
  canonical memo ellips parenthes categor neutral special standard character apolog real stabil
  central general local personal modern harmon symbol random container raster vector virtual digit
  anonym rational equal trivial ideal contextual conceptual internal external legal critic global
  familiar theor public sympath hypothes energ monet privat steril fertil styl item memor natural
  synthes subsid econom human`);
const ISE_ENDINGS = '(?:ise|ised|ises|ising|isation|isations|iser|isers|isable)';
const EL_STEMS = either(`cancel label model travel signal portal dial level channel tunnel funnel
  fuel marshal total counsel shovel swivel unravel grovel revel bevel chisel enamel pencil snorkel
  towel tassel yodel libel panel quarrel rival equal pedal spiral initial barrel duel jewel kennel
  marvel parcel`);
const OTHER = either(`centre centres centred centring metre metres litre litres fibre fibres
  theatre theatres calibre sombre spectre meagre sabre lustre manoeuvre manoeuvres
  licence licences licenced defence defences offence offences pretence
  catalogue catalogues catalogued cataloguing analogue analogues
  analyse analysed analysing analyser paralyse paralysed catalyse
  fulfil fulfils fulfilment enrol enrols enrolment instalment skilful wilful
  focussed focussing focusses programme programmes practise practised practises practising
  whilst amongst learnt spelt misspelt dreamt towards afterwards
  judgement judgements acknowledgement acknowledgements artefact artefacts ageing maths
  aluminium mould moulds sceptic sceptical enquiry enquiries enquire cosy despatch speciality
  aeroplane sulphur paediatric anaesthetic encyclopaedia pyjamas plough cheque cheques tyre tyres
  grey greys greyed greying greyish greyscale jewellery marvellous woollen`);

const BRITISH = new RegExp(
  [
    `^(?:re|mis|dis|multi|un|off)?${OUR}(?:s|ed|ing|ful|less|ite|ites|able|al|ist|hood|ly|ise|ised)?$`,
    `^(?:un|re|non|pre|over|auto|de)?${ISE_STEMS}${ISE_ENDINGS}$`,
    `^(?:un|re|mis|non|pre)?${EL_STEMS}l(?:ed|ing|er|ers)$`,
    `^(?:re|de|off)?${OTHER}$`,
  ].join('|'),
  'i'
);

interface Reviewed {
  file: string;
  /** Matches the source text around the word; the word must fall inside the match. */
  around: RegExp;
  reason: string;
}

/** British spellings that are a contract with something outside this repo, and why. */
const REVIEWED: Reviewed[] = [
  {
    file: 'apps/server/src/services/ToolService/tools/system/change-color-theme/definition.ts',
    around: /'colour',/,
    reason: 'tool-search keyword, so a query spelled the British way still finds the tool',
  },
  {
    file: 'tests/unit/apps/server/services/ToolService/tools/table-tools.select.test.ts',
    around: /colour: 'red'|unknown key "colour"/,
    reason: 'checks the clear error for the British key an agent may send',
  },
  {
    file: 'tests/unit/apps/server/services/tableSemantic/rowCard.test.ts',
    around: /'Licence key'/,
    reason: "a user's column named the British way must still count as sensitive",
  },
  {
    file: 'apps/server/native/apple-chat/chat.swift',
    around: /Task\.isCancelled/,
    reason: 'Swift concurrency API',
  },
  {
    file: 'packages/shared/utils/tableName.ts',
    around: /\banalyse analyze\b/,
    reason: 'PostgreSQL reserves both spellings',
  },
  ...[
    'apps/server/src/routes/automations.ts',
    'apps/server/src/services/ToolService/tools/automations/automation/tool.ts',
  ].map(
    (file): Reviewed => ({
      file,
      around: /finished, cancelled or all/,
      reason: 'names the status value a caller must send',
    })
  ),
  ...[
    'apps/server/src/services/BrowserController/BrowserController.ts',
    'tests/unit/apps/server/services/BrowserController.test.ts',
    'tests/unit/apps/server/services/BrowserControllerKeyHold.chromium.test.ts',
  ].map(
    (file): Reviewed => ({
      file,
      around: /\bcancelled: true\b|\b(out|r)\.cancelled\b/,
      reason: 'field of the browser tool result agents read',
    })
  ),
  ...[
    'apps/server/src/services/EmbeddingMaintenanceService.ts',
    'apps/desktop-ui/src/utils/api/types/embeddings.ts',
    'apps/desktop-ui/src/components/StatusBar/consumers/EmbeddingSlot.test.tsx',
  ].map(
    (file): Reviewed => ({
      file,
      around: /\bcancelledAt\b/,
      reason: 'field of the embeddings maintenance status API',
    })
  ),
  ...[
    'apps/server/src/domains/projects/handlers/embeddingsHandlers.ts',
    'apps/desktop-ui/src/utils/api/projects.ts',
    'apps/desktop-ui/src/pages/Dashboard/views/ContainerView/DetailsPanel/EmbeddingsSection.test.tsx',
  ].map(
    (file): Reviewed => ({
      file,
      around: /\bcancelling: (true|boolean)\b/,
      reason: 'field of the backfill cancel API response',
    })
  ),
  {
    file: 'apps/desktop-ui/src/pages/Dashboard/views/ProvidersView/Providers/components/ClaudeCodeLoginFlow/ClaudeCodeLoginFlow.tsx',
    around: /^ {2}cancelled:/m,
    reason: "keyed by the sign-in state value 'cancelled'",
  },
];

const WIRE_VALUE = /(['"`])cancelled\1/g;
const URL = /https?:\/\/[^\s'"`)>\]]+/g;

interface Finding {
  file: string;
  index: number;
  line: number;
  word: string;
  text: string;
}

/** British words in `text`: letter runs, split at camelCase humps. */
function britishWords(text: string): Array<{ index: number; word: string }> {
  const skip: Array<[number, number]> = [];
  for (const re of [WIRE_VALUE, URL]) {
    for (const m of text.matchAll(re)) skip.push([m.index, m.index + m[0].length]);
  }
  const out: Array<{ index: number; word: string }> = [];
  for (const run of text.matchAll(/[A-Za-z]+/g)) {
    let at = run.index;
    for (const word of run[0].split(/(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)) {
      if (BRITISH.test(word) && !skip.some(([a, b]) => at >= a && at < b)) {
        out.push({ index: at, word });
      }
      at += word.length;
    }
  }
  return out;
}

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\0')
    .filter((file) => SCANNED.test(file) && !SKIPPED.some((skipped) => file.startsWith(skipped)));
}

function scan(file: string): Finding[] {
  let text: string;
  try {
    text = readFileSync(path.join(REPO_ROOT, file), 'utf8');
  } catch {
    return []; // deleted in the working tree but still in the index
  }
  const lines = text.split('\n');
  return britishWords(text).map(({ index, word }) => {
    const line = text.slice(0, index).split('\n').length;
    return { file, index, line, word, text: lines[line - 1].trim() };
  });
}

function reviewedFor(finding: Finding, source: string): Reviewed | undefined {
  return REVIEWED.find((entry) => {
    if (entry.file !== finding.file) return false;
    const around = new RegExp(entry.around.source, `${entry.around.flags.replace('g', '')}g`);
    return [...source.matchAll(around)].some(
      (m) => finding.index >= m.index && finding.index < m.index + m[0].length
    );
  });
}

describe('American spelling guard', () => {
  it('splits words the way the scan relies on', () => {
    const words = (text: string) => britishWords(text).map((w) => w.word);
    expect(words('zoomAboutCentre CANCELLED_AT colour-picker isNormalised greyed')).toEqual([
      'Centre',
      'CANCELLED',
      'colour',
      'Normalised',
      'greyed',
    ]);
    expect(
      words(
        "aria-labelledby cancellation optimistic promise analyses status === 'cancelled' https://example.com/colour"
      )
    ).toEqual([]);
  });

  const files = trackedFiles();
  const sources = new Map(files.map((file) => [file, '']));
  const findings = files.flatMap((file) => {
    const found = scan(file);
    if (found.length) sources.set(file, readFileSync(path.join(REPO_ROOT, file), 'utf8'));
    return found;
  });

  it('scans the repo', () => {
    // A scan that silently reads nothing would pass everything below.
    expect(files.length).toBeGreaterThan(1000);
  });

  it('uses American spelling outside the reviewed contracts', () => {
    const unreviewed = findings
      .filter((finding) => !reviewedFor(finding, sources.get(finding.file) ?? ''))
      .map((f) => `${f.file}:${f.line} ${f.word}: ${f.text.slice(0, 120)}`);
    expect(unreviewed).toEqual([]);
  });

  it('every reviewed entry still matches a word', () => {
    const stale = REVIEWED.filter(
      (entry) =>
        !findings.some(
          (f) => f.file === entry.file && reviewedFor(f, sources.get(f.file) ?? '') === entry
        )
    ).map((entry) => `${entry.file}: ${entry.around}`);
    expect(stale).toEqual([]);
  });
});
