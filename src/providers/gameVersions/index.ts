import { FABRIC_MAVEN, PISTON_META } from "#common/constants/urls.ts";
import { HTTPCacheMode, type HTTPClient } from "#httpClient.ts";
import { defineProvider } from "#index.ts";
import { PistonVersion } from "#schemas/pistonMeta/pistonVersion.ts";
import {
	PistonVersionManifest,
	PistonVersionRef,
} from "#schemas/pistonMeta/pistonVersionManifest.ts";
import { orderBy } from "es-toolkit";

export default defineProvider({
	id: "game-versions",

	async provide(http): Promise<PistonVersion[]> {
		return Promise.all([
			pistonMetaVersions(http),
			fabricMavenVersions(http),

		]).then((versions) =>
			orderBy(
				versions.flat(),
				[(version) => version.releaseTime],
				["desc"],
			),
		);
	},
});

async function pistonMetaVersions(http: HTTPClient): Promise<PistonVersion[]> {
	const base = "piston-meta";

	const manifest = PistonVersionManifest.parse(
		(
			await http.getCached(
				new URL("mc/game/version_manifest_v2.json", PISTON_META),
				base + "/versions.json",
			)
		).json(),
	);

	return await getVersions(http, base, manifest.versions);
}

async function fabricMavenVersions(http: HTTPClient): Promise<PistonVersion[]> {
	const base = "fabric-maven";

	const manifest = PistonVersionManifest.parse(
		(
			await http.getCached(
				new URL("net/minecraft/experimental_versions.json", FABRIC_MAVEN),
				base + "/experimental_versions.json",
			)
		).json(),
	);

	return await getVersions(http, base, manifest.versions);
}

async function getVersions(
	http: HTTPClient,
	base: string,
	versions: PistonVersionRef[],
): Promise<PistonVersion[]> {
	return await Promise.all(
		versions.map(async (version): Promise<PistonVersion> => {
			const response = (
				await http.getCached(
					version.url,
					base + "/" + version.id + ".json",
					{
						mode: HTTPCacheMode.CompareLocalDigest,
						algorithm: "sha-1",
						expected: version.sha1,
					},
				)
			).json();

			// manifest ID and type should take precidence - in some cases we override it
			return {
				...PistonVersion.parse(response),
				id: version.id,
				type: version.type,
			};
		}),
	);
}
