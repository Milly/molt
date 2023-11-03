import { distinct } from "./std/collections.ts";
import {
  createGraph,
  type CreateGraphOptions,
  init as initDenoGraph,
  load as defaultLoad,
  type ModuleJson,
} from "./x/deno_graph.ts";
import { URI } from "./uri.ts";
import type { Maybe } from "./types.ts";
import { ImportMap } from "./import_map.ts";
import {
  type DependencyProps,
  parseProps,
  parseSemVer,
  resolveLatestURL,
} from "./dependency.ts";

type DependencyJson = NonNullable<ModuleJson["dependencies"]>[number];

export type VersionProp = {
  from?: string;
  to: string;
};

/** Representation of a dependency update. */
export interface DependencyUpdate extends Omit<DependencyProps, "version"> {
  /** The fully resolved specifier of the dependency. */
  specifier: {
    from: URI<"http" | "https" | "npm">;
    to: URI<"http" | "https" | "npm">;
  };
  version: VersionProp;
  /** The code of the dependency. Note that `type` in the DependencyJSON is
   * merged into `code` here for convenience. */
  code: {
    /** The original specifier of the dependency appeared in the code. */
    specifier: string;
    span: NonNullable<DependencyJson["code"]>["span"];
  };
  /** The specifier of the module that imports the dependency. */
  referrer: URI<"file">;
  /** Information about the import map used to resolve the dependency. */
  map?: {
    /** The path to the import map used to resolve the dependency. */
    source: URI<"file">;
    from: string;
    /** The string in the dependency specifier being replaced by the import map.
     * Mapping on a file specifier should not happen. */
    to: URI<"http" | "https" | "npm">;
  };
}

export const DependencyUpdate = {
  collect,
};

class DenoGraph {
  static #initialized = false;

  static async ensureInit() {
    if (this.#initialized) {
      return;
    }
    await initDenoGraph();
    this.#initialized = true;
  }
}

const load: NonNullable<CreateGraphOptions["load"]> = async (
  specifier,
) => {
  const url = new URL(specifier); // should not throw
  switch (url.protocol) {
    case "node:":
    case "npm:":
      return {
        kind: "external",
        specifier,
      };
    case "http:":
    case "https:":
      return {
        kind: "external",
        specifier,
      };
    case "file:":
      return await defaultLoad(specifier);
    default:
      throw new Error(`Unsupported protocol: ${url.protocol}`);
  }
};

export async function collect(
  entrypoints: string | string[],
  options: {
    importMap?: string;
  } = {},
): Promise<DependencyUpdate[]> {
  // This could throw if the entrypoints are not valid URIs.
  const specifiers = [entrypoints].flat().map((path) => URI.from(path));

  // Ensure the deno_graph WASM module is initialized.
  await DenoGraph.ensureInit();

  const importMap = options.importMap
    ? await ImportMap.readFromJson(URI.from(options.importMap))
    : undefined;

  const graph = await createGraph(specifiers, {
    load,
    resolve: importMap ? importMap.resolveSimple : undefined,
  });

  const updates: DependencyUpdate[] = [];
  await Promise.all(
    graph.modules.flatMap((module) =>
      module.dependencies?.map(async (dependency) => {
        const update = await _create(
          dependency,
          URI.from(module.specifier),
          { importMap },
        );
        return update ? updates.push(update) : undefined;
      })
    ),
  );
  return updates;
}

export async function _create(
  dependency: DependencyJson,
  referrer: URI<"file">,
  options?: { importMap?: ImportMap },
): Promise<DependencyUpdate | undefined> {
  const specifier = dependency.code?.specifier ?? dependency.type?.specifier;
  if (!specifier) {
    throw new Error(
      `The dependency ${dependency.specifier} in ${
        URI.relative(referrer)
      } has no resolved specifier.`,
    );
  }
  const latest = await resolveLatestURL(new URL(specifier));
  if (!latest) {
    return;
  }
  const props = parseProps(latest);
  const mapped = options?.importMap?.resolve(
    dependency.specifier,
    referrer,
  );
  const span = dependency.code?.span ?? dependency.type?.span;
  if (!span) {
    throw new Error(
      `The dependency ${dependency.specifier} in ${
        URI.relative(referrer)
      } has no span.`,
    );
  }
  return {
    ...props,
    specifier: {
      from: URI.ensure("http", "https", "npm")(specifier),
      to: URI.ensure("http", "https", "npm")(latest.href),
    },
    code: {
      // We prefer to put the original specifier here.
      specifier: dependency.specifier,
      span,
    },
    version: {
      from: parseSemVer(specifier),
      to: props.version!, // Latest URL must have a semver
    },
    referrer,
    map: mapped
      ? {
        source: options!.importMap!.specifier,
        from: mapped.from!,
        to: URI.ensure("http", "https", "npm")(mapped.to!),
      }
      : undefined,
  };
}

export function createVersionProp(
  dependencies: DependencyUpdate[],
): Maybe<VersionProp> {
  const modules = distinct(dependencies.map((d) => d.name));
  if (modules.length > 1) {
    // Cannot provide a well-defined version prop
    return;
  }
  const tos = distinct(dependencies.map((d) => d.version.to));
  if (tos.length > 1) {
    throw new Error(
      "Multiple target versions are specified for a single module",
    );
  }
  const froms = distinct(dependencies.map((d) => d.version.from));
  return {
    from: froms.length === 1 ? froms[0] : undefined,
    to: tos[0],
  };
}
