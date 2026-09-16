import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadSkills, SKILL_MAX_RESOURCES, SKILL_MAX_TOTAL_BYTES } from '../../src/server/skills/skill-loader.js';
import { logger } from '../../src/server/utils/logger.js';

let root: string;

function digest(bytes: Buffer | string): string {
	return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

interface FixtureFile {
	relativePath: string;
	content: Buffer | string;
}

interface SkillFixture {
	name: string;
	files?: FixtureFile[];
	frontmatter?: Record<string, unknown>;
	/** Emit `size` on each manifest entry, as a SEP-2640 Final snapshot does. */
	withSize?: boolean;
}

async function writeSkillFiles(fixture: SkillFixture): Promise<Record<string, unknown>> {
	const { name, withSize = false } = fixture;
	const frontmatter = fixture.frontmatter ?? { name, description: 'first skill' };
	const files = fixture.files ?? [{ relativePath: 'references/guide.md', content: '# guide\n' }];
	const skillDir = path.join(root, name);
	await mkdir(skillDir, { recursive: true });
	const skillMd = `---\nname: ${String(frontmatter.name)}\ndescription: ${String(frontmatter.description)}\n---\n\n# ${name}\n`;
	const allFiles = [{ relativePath: 'SKILL.md', content: skillMd }, ...files];
	for (const file of allFiles) {
		const target = path.join(skillDir, file.relativePath);
		await mkdir(path.dirname(target), { recursive: true });
		await writeFile(target, file.content);
	}
	return {
		uri: `skill://${name}/SKILL.md`,
		frontmatter,
		resources: allFiles.map((file) => ({
			uri: `skill://${name}/${file.relativePath.split('/').map(encodeURIComponent).join('/')}`,
			digest: digest(file.content),
			...(withSize ? { size: Buffer.byteLength(file.content) } : {}),
		})),
	};
}

async function writeSkills(fixtures: SkillFixture[]): Promise<void> {
	const skills: Record<string, unknown>[] = [];
	for (const fixture of fixtures) skills.push(await writeSkillFiles(fixture));
	await writeFile(path.join(root, 'skills.json'), JSON.stringify({ skills }));
}

async function writeSkill(
	name = 'alpha',
	files: FixtureFile[] = [{ relativePath: 'references/guide.md', content: '# guide\n' }],
	frontmatter: Record<string, unknown> = { name, description: 'first skill' }
): Promise<void> {
	await writeSkills([{ name, files, frontmatter }]);
}

async function mutateManifest(mutator: (manifest: Record<string, unknown>) => void): Promise<void> {
	const manifestPath = path.join(root, 'skills.json');
	const manifest = JSON.parse(
		await import('node:fs/promises').then((fs) => fs.readFile(manifestPath, 'utf8'))
	) as Record<string, unknown>;
	mutator(manifest);
	await writeFile(manifestPath, JSON.stringify(manifest));
}

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'hf-skill-loader-'));
});

afterEach(async () => {
	vi.restoreAllMocks();
	await rm(root, { recursive: true, force: true });
});

describe('loadSkills', () => {
	it('loads and verifies a complete multi-file snapshot into memory', async () => {
		const binary = Buffer.from([0x00, 0xff, 0x10]);
		await writeSkill('alpha', [
			{ relativePath: 'references/guide.md', content: '# guide\r\n' },
			{ relativePath: 'assets/raw.bin', content: binary },
		]);

		const catalog = await loadSkills(root, 1234);
		expect(catalog.loadedAt).toBe(1234);
		expect(catalog.entries).toHaveLength(1);
		expect(catalog.entries[0]).toMatchObject({
			uri: 'skill://alpha/SKILL.md',
			skillPath: 'alpha',
			frontmatter: { name: 'alpha', description: 'first skill' },
		});
		expect(catalog.resourcesByUri.size).toBe(3);
		expect(catalog.resourcesByUri.get('skill://alpha/assets/raw.bin')?.bytes).toEqual(binary);
		expect(catalog.directories.get('skill://alpha')).toContainEqual({
			uri: 'skill://alpha/references',
			name: 'references',
			mimeType: 'inode/directory',
		});
	});

	it('emits the verified byte size on every manifest resource', async () => {
		const binary = Buffer.from([0x00, 0xff, 0x10, 0x20]);
		await writeSkills([
			{
				name: 'alpha',
				files: [
					{ relativePath: 'references/guide.md', content: '# guide\r\n' },
					{ relativePath: 'assets/raw.bin', content: binary },
				],
				withSize: true,
			},
		]);

		const catalog = await loadSkills(root);
		const resources = catalog.entries[0]!.resources;
		expect(resources).toHaveLength(3);
		for (const resource of resources) {
			expect(resource).toEqual({
				uri: resource.uri,
				digest: resource.digest,
				size: catalog.resourcesByUri.get(resource.uri)!.bytes.length,
			});
		}
		expect(resources.find((resource) => resource.uri.endsWith('/raw.bin'))?.size).toBe(4);
		expect(resources.find((resource) => resource.uri.endsWith('/guide.md'))?.size).toBe(9);
	});

	it('fills size in from the verified bytes when an older manifest omits it', async () => {
		await writeSkill('alpha', [{ relativePath: 'references/guide.md', content: '# guide\n' }]);
		const manifestText = await import('node:fs/promises').then((fs) =>
			fs.readFile(path.join(root, 'skills.json'), 'utf8')
		);
		expect(manifestText).not.toContain('"size"');

		const catalog = await loadSkills(root);
		expect(catalog.entries[0]!.resources.find((resource) => resource.uri.endsWith('/guide.md'))).toMatchObject({
			size: Buffer.byteLength('# guide\n'),
		});
		expect(catalog.entries[0]!.resources.every((resource) => Number.isSafeInteger(resource.size))).toBe(true);
	});

	it('rejects a size mismatch exactly like a digest mismatch', async () => {
		await writeSkills([{ name: 'alpha', withSize: true }]);
		await mutateManifest((manifest) => {
			const skills = manifest.skills as { resources: { uri: string; size: number }[] }[];
			skills[0]!.resources.find((resource) => resource.uri.endsWith('/guide.md'))!.size += 1;
		});
		await expect(loadSkills(root)).rejects.toThrow(/size mismatch/u);

		await writeSkills([{ name: 'alpha', withSize: true }]);
		await mutateManifest((manifest) => {
			const skills = manifest.skills as { resources: { size: unknown }[] }[];
			skills[0]!.resources[0]!.size = '12';
		});
		await expect(loadSkills(root)).rejects.toThrow(/invalid size/u);

		await writeSkills([{ name: 'alpha', withSize: true }]);
		await mutateManifest((manifest) => {
			const skills = manifest.skills as { resources: { size: unknown }[] }[];
			skills[0]!.resources[0]!.size = -1;
		});
		await expect(loadSkills(root)).rejects.toThrow(/invalid size/u);
	});

	it('excludes a skill with more resources than the SEP-2640 limit and keeps the rest', async () => {
		const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
		const tooMany = Array.from({ length: SKILL_MAX_RESOURCES }, (_, index) => ({
			relativePath: `files/${index}.txt`,
			content: `${index}`,
		}));
		await writeSkills([{ name: 'bloated', files: tooMany }, { name: 'alpha' }]);

		const catalog = await loadSkills(root);
		expect(catalog.entries.map((entry) => entry.uri)).toEqual(['skill://alpha/SKILL.md']);
		expect(catalog.entriesByUri.has('skill://bloated/SKILL.md')).toBe(false);
		expect(catalog.resourcesByUri.has('skill://bloated/SKILL.md')).toBe(false);
		expect(catalog.directories.has('skill://bloated')).toBe(false);
		expect(warn).toHaveBeenCalledWith(
			expect.objectContaining({
				skill: 'skill://bloated/SKILL.md',
				reason: expect.stringContaining('resources exceeds'),
			}),
			expect.stringContaining('SEP-2640')
		);
	});

	it('excludes a skill whose total size exceeds the SEP-2640 limit, from declared or verified sizes', async () => {
		const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
		const huge = Buffer.alloc(SKILL_MAX_TOTAL_BYTES, 0x61);

		// Declared sizes: excluded before any file is read.
		await writeSkills([
			{ name: 'huge', files: [{ relativePath: 'assets/big.bin', content: huge }], withSize: true },
			{ name: 'alpha' },
		]);
		let catalog = await loadSkills(root);
		expect(catalog.entries.map((entry) => entry.uri)).toEqual(['skill://alpha/SKILL.md']);
		expect(catalog.resourcesByUri.has('skill://huge/assets/big.bin')).toBe(false);
		expect(warn).toHaveBeenCalledWith(
			expect.objectContaining({
				skill: 'skill://huge/SKILL.md',
				reason: expect.stringContaining('total bytes exceeds'),
			}),
			expect.stringContaining('SEP-2640')
		);

		// No declared sizes: excluded after verification, without failing the snapshot.
		warn.mockClear();
		await writeSkills([
			{ name: 'huge', files: [{ relativePath: 'assets/big.bin', content: huge }] },
			{ name: 'alpha' },
		]);
		catalog = await loadSkills(root);
		expect(catalog.entries.map((entry) => entry.uri)).toEqual(['skill://alpha/SKILL.md']);
		expect(catalog.resourcesByUri.has('skill://huge/assets/big.bin')).toBe(false);
		expect(warn).toHaveBeenCalledTimes(1);

		// Exactly at the limit is still served.
		const atLimit = Buffer.alloc(
			SKILL_MAX_TOTAL_BYTES - Buffer.byteLength('---\nname: exact\ndescription: first skill\n---\n\n# exact\n'),
			0x62
		);
		await writeSkills([
			{ name: 'exact', files: [{ relativePath: 'assets/big.bin', content: atLimit }], withSize: true },
		]);
		catalog = await loadSkills(root);
		expect(catalog.entries.map((entry) => entry.uri)).toEqual(['skill://exact/SKILL.md']);
		expect(catalog.entries[0]!.resources.reduce((sum, resource) => sum + resource.size, 0)).toBe(SKILL_MAX_TOTAL_BYTES);
	});

	it('retains verified bytes after the backing file changes', async () => {
		await writeSkill();
		const catalog = await loadSkills(root);
		const uri = 'skill://alpha/references/guide.md';
		const before = catalog.resourcesByUri.get(uri)?.bytes.toString('utf8');
		await writeFile(path.join(root, 'alpha/references/guide.md'), '# changed\n');
		expect(catalog.resourcesByUri.get(uri)?.bytes.toString('utf8')).toBe(before);
	});

	it('supports organizational prefixes and encoded filenames', async () => {
		await mkdir(path.join(root, 'acme', 'refunds'), { recursive: true });
		const skillMd = '---\nname: refunds\ndescription: Process refunds\n---\n';
		await writeFile(path.join(root, 'acme/refunds/SKILL.md'), skillMd);
		await writeFile(path.join(root, 'acme/refunds/a b.txt'), 'space');
		await writeFile(
			path.join(root, 'skills.json'),
			JSON.stringify({
				skills: [
					{
						uri: 'skill://acme/refunds/SKILL.md',
						frontmatter: { name: 'refunds', description: 'Process refunds' },
						resources: [
							{ uri: 'skill://acme/refunds/SKILL.md', digest: digest(skillMd) },
							{ uri: 'skill://acme/refunds/a%20b.txt', digest: digest('space') },
						],
					},
				],
			})
		);
		const catalog = await loadSkills(root);
		expect(catalog.entries[0]?.skillPath).toBe('acme/refunds');
		expect(catalog.resourcesByUri.has('skill://acme/refunds/a%20b.txt')).toBe(true);
	});

	it('rejects a digest mismatch', async () => {
		await writeSkill();
		await mutateManifest((manifest) => {
			const skills = manifest.skills as { resources: { digest: string }[] }[];
			skills[0]!.resources[0]!.digest = `sha256:${'0'.repeat(64)}`;
		});
		await expect(loadSkills(root)).rejects.toThrow(/digest mismatch/u);
	});

	it('rejects a manifest that omits a published supporting file', async () => {
		await writeSkill();
		await mutateManifest((manifest) => {
			const skills = manifest.skills as { resources: { uri: string }[] }[];
			skills[0]!.resources = skills[0]!.resources.filter((resource) => !resource.uri.endsWith('/guide.md'));
		});
		await expect(loadSkills(root)).rejects.toThrow(/manifest is incomplete/u);
	});

	it('rejects invalid digest syntax, duplicate resources, and a missing SKILL.md resource', async () => {
		await writeSkill();
		await mutateManifest((manifest) => {
			const skills = manifest.skills as { resources: { uri: string; digest: string }[] }[];
			skills[0]!.resources[0]!.digest = 'sha256:nope';
		});
		await expect(loadSkills(root)).rejects.toThrow(/valid uri and SHA-256/u);

		await writeSkill();
		await mutateManifest((manifest) => {
			const skills = manifest.skills as { resources: { uri: string; digest: string }[] }[];
			skills[0]!.resources.push({ ...skills[0]!.resources[0]! });
		});
		await expect(loadSkills(root)).rejects.toThrow(/duplicate skill resource/u);

		await writeSkill();
		await mutateManifest((manifest) => {
			const skills = manifest.skills as { resources: { uri: string }[] }[];
			skills[0]!.resources = skills[0]!.resources.filter((resource) => !resource.uri.endsWith('/SKILL.md'));
		});
		await expect(loadSkills(root)).rejects.toThrow(/does not include its SKILL.md/u);
	});

	it('rejects traversal, resources outside the skill root, and symlinks', async () => {
		await writeSkill();
		await mutateManifest((manifest) => {
			const skills = manifest.skills as { resources: { uri: string }[] }[];
			skills[0]!.resources[0]!.uri = 'skill://alpha/%2e%2e/outside';
		});
		await expect(loadSkills(root)).rejects.toThrow(/unsafe skill resource URI/u);

		await writeSkill();
		await mutateManifest((manifest) => {
			const skills = manifest.skills as { resources: { uri: string }[] }[];
			skills[0]!.resources[0]!.uri = 'skill://beta/SKILL.md';
		});
		await expect(loadSkills(root)).rejects.toThrow(/outside skill/u);

		await writeSkill();
		await rm(path.join(root, 'alpha/references/guide.md'));
		try {
			await symlink(path.join(root, 'alpha/SKILL.md'), path.join(root, 'alpha/references/guide.md'));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
			throw error;
		}
		await expect(loadSkills(root)).rejects.toThrow(/not a regular file/u);
	});

	it('rejects malformed, mismatched, or invalid Agent Skills frontmatter', async () => {
		await writeSkill();
		await mutateManifest((manifest) => {
			const skills = manifest.skills as { frontmatter: { description: string } }[];
			skills[0]!.frontmatter.description = 'different';
		});
		await expect(loadSkills(root)).rejects.toThrow(/frontmatter mismatch/u);

		await writeSkill('BadName', [], { name: 'BadName', description: 'bad' });
		await expect(loadSkills(root)).rejects.toThrow(/invalid or mismatched/u);

		await writeSkill('alpha', [], {
			name: 'alpha',
			description: 'first skill',
			metadata: { tags: ['bad'] },
		});
		await expect(loadSkills(root)).rejects.toThrow(/metadata must map/u);
	});

	it('rejects ambiguous YAML and invalid UTF-8 in the actual SKILL.md', async () => {
		await writeSkill();
		const duplicateYaml = '---\nname: alpha\nname: alpha\ndescription: first skill\n---\n';
		await writeFile(path.join(root, 'alpha/SKILL.md'), duplicateYaml);
		await mutateManifest((manifest) => {
			const skills = manifest.skills as { resources: { uri: string; digest: string }[] }[];
			skills[0]!.resources.find((resource) => resource.uri.endsWith('/SKILL.md'))!.digest = digest(duplicateYaml);
		});
		await expect(loadSkills(root)).rejects.toThrow(/invalid YAML frontmatter/u);

		await writeSkill();
		const invalidUtf8 = Buffer.from([0xff, 0xfe, 0xfd]);
		await writeFile(path.join(root, 'alpha/SKILL.md'), invalidUtf8);
		await mutateManifest((manifest) => {
			const skills = manifest.skills as { resources: { uri: string; digest: string }[] }[];
			skills[0]!.resources.find((resource) => resource.uri.endsWith('/SKILL.md'))!.digest = digest(invalidUtf8);
		});
		await expect(loadSkills(root)).rejects.toThrow(/not valid UTF-8/u);
	});

	it('rejects missing or invalid manifest JSON', async () => {
		await expect(loadSkills(root)).rejects.toThrow(/skills\.json/u);
		await writeFile(path.join(root, 'skills.json'), '{nope');
		await expect(loadSkills(root)).rejects.toThrow();
		await writeFile(path.join(root, 'skills.json'), '{}');
		await expect(loadSkills(root)).rejects.toThrow(/skills array/u);
	});

	it('rejects symlinked and oversized manifests', async () => {
		const outside = path.join(root, 'outside.json');
		await writeFile(outside, JSON.stringify({ skills: [] }));
		try {
			await symlink(outside, path.join(root, 'skills.json'));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
			throw error;
		}
		await expect(loadSkills(root)).rejects.toThrow(/regular manifest/u);

		await rm(path.join(root, 'skills.json'));
		await writeFile(path.join(root, 'skills.json'), 'x'.repeat(5 * 1024 * 1024 + 1));
		await expect(loadSkills(root)).rejects.toThrow(/maximum size/u);
	});

	it('rejects excessive skill and resource counts before loading files', async () => {
		await writeFile(
			path.join(root, 'skills.json'),
			JSON.stringify({ skills: Array.from({ length: 1_001 }, () => ({})) })
		);
		await expect(loadSkills(root)).rejects.toThrow(/maximum skill count/u);

		await writeFile(
			path.join(root, 'skills.json'),
			JSON.stringify({
				skills: [
					{
						uri: 'skill://alpha/SKILL.md',
						frontmatter: { name: 'alpha', description: 'alpha' },
						resources: Array.from({ length: 10_001 }, () => ({
							uri: 'skill://alpha/SKILL.md',
							digest: `sha256:${'0'.repeat(64)}`,
						})),
					},
				],
			})
		);
		await expect(loadSkills(root)).rejects.toThrow(/maximum resource count/u);
	});
});
