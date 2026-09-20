import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { memoizeByKey, memoizeJsonSchemaConversion } from './schema-cache.js';

type JsonSchemaMethod = (params?: unknown) => unknown;

/** Reads the Standard Schema JSON Schema hook the MCP SDK calls. */
function jsonSchemaHook(schema: unknown): { input: JsonSchemaMethod; output: JsonSchemaMethod } {
	return (schema as { ['~standard']: { jsonSchema: { input: JsonSchemaMethod; output: JsonSchemaMethod } } })[
		'~standard'
	].jsonSchema;
}

describe('memoizeJsonSchemaConversion', () => {
	it('converts once per set of params and reuses the result', () => {
		const schema = z.object({ name: z.string() });
		const hook = jsonSchemaHook(schema);
		const spy = vi.fn(hook.input);
		hook.input = spy;

		memoizeJsonSchemaConversion(schema);
		const first = jsonSchemaHook(schema).input({ target: 'draft-2020-12' });
		const second = jsonSchemaHook(schema).input({ target: 'draft-2020-12' });

		expect(spy).toHaveBeenCalledTimes(1);
		expect(second).toBe(first);
	});

	it('keeps results for different params apart', () => {
		const schema = z.object({ name: z.string() });
		memoizeJsonSchemaConversion(schema);
		const hook = jsonSchemaHook(schema);

		expect(hook.input({ target: 'draft-7' })).not.toBe(hook.input({ target: 'draft-2020-12' }));
	});

	it('produces the same JSON Schema as the uncached conversion', () => {
		const params = { target: 'draft-2020-12' };
		const plain = jsonSchemaHook(z.object({ id: z.string(), count: z.number().optional() })).input(params);

		const cached = z.object({ id: z.string(), count: z.number().optional() });
		memoizeJsonSchemaConversion(cached);

		expect(jsonSchemaHook(cached).input(params)).toEqual(plain);
	});

	it('is idempotent', () => {
		const schema = z.object({ name: z.string() });
		memoizeJsonSchemaConversion(schema);
		const wrapped = jsonSchemaHook(schema).input;
		memoizeJsonSchemaConversion(schema);

		expect(jsonSchemaHook(schema).input).toBe(wrapped);
	});

	it('leaves values without the hook untouched', () => {
		expect(() => memoizeJsonSchemaConversion(undefined)).not.toThrow();
		expect(memoizeJsonSchemaConversion({ plain: true })).toEqual({ plain: true });
	});

	it('bypasses the cache when params carry more than a target', () => {
		const schema = z.object({ name: z.string() });
		const hook = jsonSchemaHook(schema);
		const spy = vi.fn(hook.input);
		hook.input = spy;
		memoizeJsonSchemaConversion(schema);

		const params = { target: 'draft-2020-12', libraryOptions: { cycles: 'ref' } };
		jsonSchemaHook(schema).input(params);
		jsonSchemaHook(schema).input(params);

		expect(spy).toHaveBeenCalledTimes(2);
	});

	it('gives up quietly when the hook cannot be patched', () => {
		const schema = z.object({ name: z.string() });
		const original = jsonSchemaHook(schema).input;
		Object.freeze(jsonSchemaHook(schema));

		expect(() => memoizeJsonSchemaConversion(schema)).not.toThrow();
		expect(jsonSchemaHook(schema).input).toBe(original);
	});
});

describe('memoizeByKey', () => {
	it('builds once per key', () => {
		const factory = vi.fn((name: string | undefined) => ({ name }));
		const memo = memoizeByKey(factory, 8);

		expect(memo('alice')).toBe(memo('alice'));
		expect(memo('bob')).not.toBe(memo('alice'));
		expect(factory).toHaveBeenCalledTimes(2);
	});

	it('evicts the oldest entry past the limit', () => {
		const memo = memoizeByKey((name: string) => ({ name }), 2);

		const first = memo('a');
		memo('b');
		memo('c'); // evicts 'a'

		expect(memo('a')).not.toBe(first);
	});
});
