/**
 * The SDK converts every tool schema to JSON Schema at registration and again on
 * `tools/list`, and zod does not memoize it. Since a full-server request rebuilds the
 * server and re-registers every tool, that conversion dominated a production CPU profile.
 *
 * Removing it needs both halves: build each schema once (`memoizeByKey`), then cache the
 * conversion on that instance (`memoizeJsonSchemaConversion`).
 */

/** Conversion method exposed by Standard Schema as `~standard.jsonSchema.{input,output}`. */
type JsonSchemaMethod = (params?: unknown) => unknown;

type JsonSchemaHook = Record<string, JsonSchemaMethod>;

const memoizedHooks = new WeakSet<JsonSchemaHook>();

/** Keyed on `target`; anything else in the params bag changes the output, so it bypasses. */
function memoizeMethod(method: JsonSchemaMethod): JsonSchemaMethod {
	const byTarget = new Map<unknown, unknown>();
	return (params?: unknown) => {
		const bag = params as Record<string, unknown> | undefined;
		if (bag !== undefined && Object.keys(bag).some((key) => key !== 'target')) return method(params);

		const target = bag?.target;
		if (!byTarget.has(target)) byTarget.set(target, method(params));
		return byTarget.get(target);
	};
}

/**
 * Caches the JSON Schema conversion of `schema`, in place. Idempotent, and a no-op for
 * values without the Standard Schema hook or with a schema rebuilt per request.
 *
 * Standard Schema declares these methods `readonly`; we rely on zod's writable
 * implementation. If a future version freezes them we skip the patch and convert
 * uncached, because an optimization must not break the server.
 */
export function memoizeJsonSchemaConversion<T>(schema: T): T {
	const hook = (schema as { ['~standard']?: { jsonSchema?: JsonSchemaHook } } | null | undefined)?.['~standard']
		?.jsonSchema;
	if (!hook || memoizedHooks.has(hook)) return schema;

	for (const io of ['input', 'output'] as const) {
		const method = hook[io];
		if (typeof method !== 'function') continue;
		const memoized = memoizeMethod(method);
		try {
			hook[io] = memoized;
		} catch {
			return schema;
		}
		if (hook[io] !== memoized) return schema;
	}
	memoizedHooks.add(hook);
	return schema;
}

/** Memoizes a single-argument factory, keeping at most `maxEntries` in insertion order. */
export function memoizeByKey<K, V>(factory: (key: K) => V, maxEntries: number): (key: K) => V {
	const cache = new Map<K, V>();
	return (key: K): V => {
		if (cache.has(key)) return cache.get(key) as V;
		const value = factory(key);
		if (cache.size >= maxEntries) {
			const oldest = cache.keys().next();
			if (!oldest.done) cache.delete(oldest.value);
		}
		cache.set(key, value);
		return value;
	};
}
