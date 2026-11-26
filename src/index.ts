// SPDX-FileCopyrightText: 2026 metabolism contributors
//
// SPDX-License-Identifier: MIT

import pino, { type Logger } from "pino";
import type { VersionFile } from "./schemas/format/v1/versionFile.ts";

export const rootLogger = pino({
	level: process.env.PINO_LOG_LEVEL || "info",
});

// https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/digest#algorithm
export type CacheHashFunction = "sha-1" | "sha-256" | "sha-384" | "sha-512";

export type CacheChecksum = { algorithm: CacheHashFunction; expected: string };

export interface Cache {
	/**
	 * Get content stored in the cache, or compute and store it.
	 * @param key A unique key to cache the data or retrieve it from cache
	 * @param compute A function to provide the content in event of a cache miss
	 * @param checksum If present, the cached entry will only be used if it matches the expected checksum
	 * @return Stored or computed content
	 */
	getOrCompute(
		key: string,
		compute: () => string | Promise<string>,
		checksum?: CacheChecksum,
	): Promise<string>;

	get(key: string, content?: CacheChecksum): Promise<string | null>;

	set(key: string, value: string): Promise<void>;
}

export interface Provider<TData = unknown> {
	id: string;

	provide(logger: Logger, cache: Cache): Promise<TData>;
}

export function defineProvider<D>(provider: Provider<D>): Provider<D> {
	return provider;
}

export type ProviderData<TProviders extends Provider[]> = {
	[I in keyof TProviders]: TProviders[I] extends Provider<infer TData> ? TData
	:	never;
};

export interface Goal<TProviders extends Provider[] = Provider[]> {
	/** ID (based on reverse domain name) for output - e.g. net.minecraft for Minecraft */
	id: string;
	name: string;
	deps: TProviders;

	generate(logger: Logger, data: ProviderData<TProviders>): VersionOutput[];
}

export function defineGoal<const TProviders extends Provider[]>(
	goal: Goal<TProviders>,
): Goal<TProviders> {
	return goal;
}

export type VersionOutput = Omit<
	VersionFile,
	"uid" | "name" | "formatVersion"
> & { recommended?: boolean };
