/** Authored long fixtures, not semantic judgments derived from the model. */
export const answers = [
  {
    key: 'start',
    answer: 'The emergency beacon is powered by a violet battery.',
    query: 'What supplies electricity to the distress signal?',
  },
  {
    key: 'middle',
    answer: 'The rescue boat departs from Cedar Harbor at dawn.',
    query: 'Where does the evacuation vessel leave from?',
  },
  {
    key: 'end',
    answer: 'The winter shelter access code is seven copper owls.',
    query: 'What password opens the cold season refuge?',
  },
];
export const filler =
  'Routine maintenance records describe inventory checks and ordinary equipment inspections. ';
export const documentBody =
  '# Field handbook\n\n' +
  answers[0].answer +
  '\n\n## Inventory\n' +
  filler.repeat(32) +
  '\n\n## Evacuation\n' +
  answers[1].answer +
  '\n' +
  filler.repeat(32) +
  '\n\n## Winter access\n' +
  answers[2].answer;
export const codeBody =
  '// Field handbook\n' +
  answers
    .map(
      (a, i) =>
        `// ${a.answer}\nexport function section${i}() {\n${'  const sample = {x: [1,2,3], y: true};\n'.repeat(40)}  return "${a.key}";\n}\n`
    )
    .join('\n');
export const denseBody = '# Dense identifiers\n' + 'a+b=c; '.repeat(700);
