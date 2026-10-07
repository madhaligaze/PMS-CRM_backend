/**
 * Провайдер схем кладёт в компоненты и входной, и выходной вариант каждой
 * зарегистрированной схемы, даже если вход нигде не используется. В контракте
 * для клиентов остаются только схемы, на которые реально ссылаются пути.
 */

type Json = Record<string, unknown>;
const PREFIX = '#/components/schemas/';

function collectRefs(node: unknown, into: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, into);
    return;
  }
  if (!node || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node as Json)) {
    if (key === '$ref' && typeof value === 'string' && value.startsWith(PREFIX)) into.add(value.slice(PREFIX.length));
    else collectRefs(value, into);
  }
}

export function pruneUnusedSchemas<T>(doc: T): T {
  const d = doc as Json & { paths?: Json; components?: { schemas?: Json } };
  const schemas = d.components?.schemas;
  if (!schemas) return doc;
  const used = new Set<string>();
  collectRefs(d.paths ?? {}, used);
  const queue = [...used];
  while (queue.length) {
    const name = queue.pop()!;
    const nested = new Set<string>();
    collectRefs(schemas[name], nested);
    for (const n of nested) {
      if (!used.has(n)) {
        used.add(n);
        queue.push(n);
      }
    }
  }
  const kept: Json = {};
  for (const name of Object.keys(schemas).sort()) if (used.has(name)) kept[name] = schemas[name];
  return { ...d, components: { ...d.components, schemas: kept } } as T;
}
