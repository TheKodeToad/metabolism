// SPDX-FileCopyrightText: 2026 metabolism contributors
//
// SPDX-License-Identifier: MIT

import {
	digestStringToHex,
	readFileIfExists,
	setIfAbsent,
} from "#common/util.ts";
import type { Cache, CacheChecksum, Provider } from "#index.ts";
import { rootLogger, type Goal, type VersionOutput } from "#index.ts";
import type {
	IndexFile,
	IndexFilePackage,
} from "#schemas/format/v1/indexFile.ts";
import type {
	PackageIndexFile,
	PackageIndexFileVersion,
} from "#schemas/format/v1/packageIndexFile.ts";
import type { VersionFile } from "#schemas/format/v1/versionFile.ts";
import { omit, pick, sortBy } from "es-toolkit";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";

const logger = rootLogger.child({ name: "runner" });

export interface RunnerOptions {
	cacheDir: string;
	outputDir: string;
	minify: boolean;
}

export interface RunnerSummary {
	successfulProviderCount: number;
	successfulGoalCount: number;
	failedProviderCount: number;
	failedGoalCount: number;
}

export async function prepare(
	providers: Set<Provider>,
	options: RunnerOptions,
): Promise<RunnerSummary> {
	return await run(providers, new Map(), options);
}

export async function build(
	goals: Set<Goal>,
	options: RunnerOptions,
): Promise<RunnerSummary> {
	const providers: Set<Provider> = new Set();
	const dependents: Map<Provider, Goal[]> = new Map();

	for (const goal of goals) {
		for (const dep of goal.deps) {
			providers.add(dep);
			setIfAbsent(dependents, dep, []).push(goal);
		}
	}

	return await run(providers, dependents, options);
}

class ProviderCache implements Cache {
	#baseDir: string;

	constructor(baseDir: string) {
		this.#baseDir = path.join(baseDir, "/");
	}

	#resolve(key: string): [contentPath: string, sha1Path: string] {
		const resolved = path.join(this.#baseDir, key);
		if (!resolved.startsWith(this.#baseDir)) {
			throw new Error(
				`Cache key '${key}' escapes base dir '${this.#baseDir}'`,
			);
		}

		return [resolved, resolved + ".sha1"];
	}

	async getOrCompute(
		key: string,
		compute: () => string | Promise<string>,
		checksum?: CacheChecksum,
	): Promise<string> {
		const existing = await this.get(key, checksum);
		if (existing !== null) {
			return existing;
		}

		const newContent = await compute();
		await this.set(key, newContent);
		return newContent;
	}

	async get(key: string, checksum?: CacheChecksum): Promise<string | null> {
		const [contentPath, sha1Path] = this.#resolve(key);

		const content = await readFileIfExists(contentPath, "utf-8");
		if (content === null) {
			return null;
		}

		const cachedSha1 = await readFileIfExists(sha1Path, "utf-8");
		if (cachedSha1 === null) {
			return null;
		}

		const actualSha1 = await digestStringToHex("sha-1", content);
		if (cachedSha1.toLowerCase() !== actualSha1) {
			return null;
		}

		if (checksum !== undefined) {
			const actualChecksum =
				checksum.algorithm === "sha-1" ?
					actualSha1
				:	await digestStringToHex(checksum.algorithm, content);
			if (checksum.expected.toLowerCase() !== actualChecksum) {
				return null;
			}
		}

		return content;
	}

	async set(key: string, value: string): Promise<void> {
		const [contentPath, sha1Path] = this.#resolve(key);
		await mkdir(path.dirname(contentPath), { recursive: true });

		await writeFile(
			sha1Path,
			await digestStringToHex("sha-1", value),
			"utf-8",
		);
		await writeFile(contentPath, value, "utf-8");
	}
}

async function run(
	providers: Set<Provider>,
	dependents: Map<Provider, Goal[]>,
	options: RunnerOptions,
): Promise<RunnerSummary> {
	const startTime = Date.now();

	const satisfiedDeps: Map<Goal, number> = new Map();

	const providerResults: Map<Provider, unknown> = new Map();
	const goalResults: { goal: Goal; sha256: string }[] = [];
	let failedGoalCount = 0;

	const goalDepFinished = async (goal: Goal): Promise<void> => {
		const counter = (satisfiedDeps.get(goal) ?? 0) + 1;

		if (counter > goal.deps.length) {
			throw new Error(
				`Satisfied counter exceeded number of deps (${goal.deps.length}) for goal '${goal.name}'`,
			);
		}

		satisfiedDeps.set(goal, counter);

		if (counter !== goal.deps.length) {
			return;
		}

		const goalLogger = logger.child({
			name: "goal:" + goal.id,
		});

		goalLogger.info("Running goal");

		try {
			const missingDeps = goal.deps.filter(
				(dep) => !providerResults.has(dep),
			);
			if (missingDeps.length !== 0) {
				throw new Error(
					"Dependencies failed: "
						+ missingDeps.map((x) => x.id).join(", "),
				);
			}

			const data = goal.deps.map((dep) => providerResults.get(dep));
			const sha256 = await runGoal(goalLogger, goal, data, options);
			goalResults.push({ goal, sha256 });
			goalLogger.info("Goal completed!");
		} catch (error) {
			++failedGoalCount;
			goalLogger.error(error, "Goal failed!");
		}
	};

	await Promise.all(
		providers.values().map(async (provider) => {
			const providerLogger = rootLogger.child({
				name: "provider:" + provider.id,
			});

			providerLogger.info("Running provider");

			try {
				const providerResult = await provider.provide(
					providerLogger,
					new ProviderCache(path.join(options.cacheDir, provider.id)),
				);
				providerResults.set(provider, providerResult);
				providerLogger.info("Provider completed!");
			} catch (error) {
				providerLogger.error("Provider failed!");
			}

			const providerDependents = dependents.get(provider);

			if (!providerDependents) {
				return;
			}

			return await Promise.all(providerDependents.map(goalDepFinished));
		}),
	);

	const elapsedTime = Date.now() - startTime;
	const formattedTime =
		elapsedTime < 1000 ? elapsedTime + "ms" : elapsedTime / 1000 + "s";

	const summary: RunnerSummary = {
		successfulProviderCount: providerResults.size,
		successfulGoalCount: goalResults.length,
		failedProviderCount: providers.size - providerResults.size,
		failedGoalCount: failedGoalCount,
	};
	logger.info(summary, "Summary");

	const indexPath = path.join(options.outputDir, "index.json");

	let packages: IndexFilePackage[] = [];

	// TODO: is there a better way to do this? if the formatVersion changes the old data is lost, and we don't properly validate the data either
	const existingIndexContent = await readFileIfExists(indexPath, "utf-8");
	if (existingIndexContent) {
		let obj: any;
		try {
			obj = JSON.parse(existingIndexContent);
		} catch {
			/* empty */
		}

		if (obj && obj.formatVersion == 1 && obj.packages) {
			packages = obj.packages;
		}
	}

	for (const { goal, sha256 } of goalResults) {
		const existingIndex = packages.findIndex((x) => x.uid === goal.id);
		if (existingIndex !== -1) {
			packages.splice(existingIndex, 1);
		}

		packages.push({ uid: goal.id, name: goal.name, sha256 });
	}
	const index: IndexFile = {
		formatVersion: 1,
		packages: sortBy(packages, ["uid"]),
	};

	await writeFile(indexPath, JSON.stringify(index, undefined, 2));

	logger.info(`Done in ${formattedTime}!`);

	return summary;
}

async function runGoal(
	goalLogger: Logger,
	goal: Goal,
	data: unknown[],
	options: RunnerOptions,
): Promise<string> {
	const outputs = goal.generate(goalLogger, data);
	const outputDir = path.join(options.outputDir, goal.id, path.sep);

	await mkdir(outputDir, { recursive: true });

	const space = options.minify ? 0 : 2;

	const indexVersions = await Promise.all(
		outputs.map(async (output): Promise<PackageIndexFileVersion> => {
			if (
				output.version === "index"
				|| output.version.includes("/")
				|| output.version.includes("\\")
			) {
				throw new Error(`Invalid version: '${output.version}'`);
			}

			const outputPath = path.join(outputDir, output.version + ".json");

			if (outputPath.includes("\0")) {
				throw new Error("Version contains null bytes");
			}

			if (!outputPath.startsWith(outputDir)) {
				// should never happen - just to be extra sure
				throw new Error(
					`Version '${output.version}' escapes output directory`,
				);
			}

			const versionFile = generateVersionFile(goal, output);
			const outputData = JSON.stringify(versionFile, undefined, space);

			await writeFile(outputPath, outputData);

			goalLogger.debug(`Wrote '${outputPath}'`);

			const sha256 = await digestStringToHex("sha-256", outputData);

			goalLogger.debug(`sha-256 of '${outputPath}' is ${sha256}`);

			return {
				...pick(output, [
					"version",
					"type",
					"releaseTime",
					"conflicts",
					"requires",
				]),
				recommended: output.recommended ?? false,
				sha256,
			};
		}),
	);

	const indexFile: PackageIndexFile = {
		uid: goal.id,
		name: goal.name,
		formatVersion: 1,
		versions: indexVersions,
	};

	const indexPath = path.join(outputDir, "index.json");
	const indexData = JSON.stringify(indexFile, undefined, 2);

	await writeFile(indexPath, indexData);

	goalLogger.debug(`Wrote '${indexPath}'`);

	const indexSha256 = await digestStringToHex("sha-256", indexData);

	return indexSha256;
}

function generateVersionFile(goal: Goal, output: VersionOutput): VersionFile {
	const file: VersionFile = {
		uid: goal.id,
		name: goal.name,
		formatVersion: 1,
		...omit(output, ["recommended"]),
	};

	// give it a little trim :)
	if (file.requires?.length === 0) {
		delete file.requires;
	}

	if (file["+traits"]?.length === 0) {
		delete file["+traits"];
	}

	if (file["+tweakers"]?.length === 0) {
		delete file["+tweakers"];
	}

	if (file.compatibleJavaMajors?.length === 0) {
		delete file.compatibleJavaMajors;
	}

	if (file["+jvmArgs"]?.length === 0) {
		delete file["+jvmArgs"];
	}

	if (file.libraries?.length === 0) {
		delete file.libraries;
	}

	return file;
}
