export {
  TableCatalog,
  CUSTOM_TABLES_SCHEMA,
  ENTRY_POSITION_COLUMN,
  PHYSICAL_TABLE_NAME_PATTERN,
  schemaForOrigin,
  isTableOrigin,
  isTableLifecycleState,
  tombstoneName,
  toTableCatalogEntry,
} from './TableCatalogModel';
export type {
  TableCatalogRow,
  RegisterCustomTableInput,
  ListTablesOptions,
  PhysicalColumn,
  TablePlacementInput,
  TablePlacementResult,
} from './TableCatalogModel';
