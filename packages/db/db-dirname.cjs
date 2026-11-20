// CJS fallback for Jest — provides __dirname without import.meta.url.
// Jest never runs migrations.ts / db.ts as the main entry, so isMainModule
// always returns false from here.
module.exports = {
  dbDirname: __dirname,
  isMainModule: () => false,
  isCliEntry: () => false,
};
