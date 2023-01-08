// Import Node.js Dependencies
import path from "node:path";
import timers from "node:timers/promises";
import { on, EventEmitter } from "node:events";

// Import Third-party Dependencies
import { search } from "@nodesecure/npm-registry-sdk";
import { klona } from "klona/json";
import is from "@slimio/is";
import Locker from "@slimio/lock";

// Import Internal Dependencies
import { fetchPackage } from "./src/utils.js";

// CONSTANTS
const kRegSearchLimit = 10;
const kDefaultCriteria = { popularity: 1 };
const kDefaultLimit = 500;

// eslint-disable-next-line func-style
const kDefaultFetcher = (raw: { package: { name: string; version: number } }) => `${raw.package.name}@${raw.package.version}`;
const kMaximumConcurrentDownload = 5;

export interface IRunOptions {
  name: string;
  location: string;
  root: string;
}

export interface ISearchPackagesByCriteriaOptions {
  limit?: string;
  delay?: string;
  dataFetcher?: any;
  criteria?: any;
}

export async function* searchPackagesByCriteria(
  options: ISearchPackagesByCriteriaOptions = {}
) {
  const limit = Number(options.limit) || kDefaultLimit;
  const delay = Number(options.delay) || 0;
  const dataFetcher = is.func(options.dataFetcher)
    ? options.dataFetcher
    : kDefaultFetcher;
  const criteria = is.plainObject(options.criteria)
    ? klona(options.criteria)
    : kDefaultCriteria;
  let from = 0;

  while (true) {
    const searchOptions = Object.assign(criteria, {
      text: "boost-exact:true",
      size: kRegSearchLimit,
      from
    });
    const { objects }: any = await search(searchOptions);
    yield* objects.map(dataFetcher);

    from += kRegSearchLimit;
    if (from >= limit) {
      break;
    }

    if (delay > 0) {
      await timers.setTimeout(delay);
    }
  }
}

// eslint-disable-next-line max-params
export async function downloadFromSource(
  source: AsyncGenerator<any, void, any>,
  ee: EventEmitter,
  lock: Locker,
  tmpLocation: string
) {
  try {
    for await (const packageExpr of source) {
      const free = await lock.acquireOne();

      setImmediate(() => {
        const tmpPathLocation = path.join(tmpLocation, packageExpr);
        fetchPackage(packageExpr, tmpPathLocation)
          .then(() => {
            ee.emit("row", {
              done: false,
              value: {
                name: packageExpr,
                location: tmpPathLocation,
                root: tmpLocation
              }
            });
            free();
          })
          .catch(console.error);
      });
    }
    ee.emit("row", { done: true });
  }
  catch (error) {
    ee.emit("row", { done: true, error });
  }
}

export type IDownloadPackageOnRegistryOptions = {
  tempLocation: string;
  maxConcurrent?: number;
};

export async function* downloadPackageOnRegistry(
  source: AsyncGenerator<any, void, any>,
  options: IDownloadPackageOnRegistryOptions
) {
  const { tempLocation, maxConcurrent = kMaximumConcurrentDownload } = options;

  const lock = new Locker({ maxConcurrent });
  const ee = new EventEmitter();

  setImmediate(() => downloadFromSource(source, ee, lock, tempLocation));

  for await (const [data] of on(ee, "row")) {
    const { done, error = null, value = null } = data;
    if (done) {
      if (error !== null) {
        throw error;
      }
      break;
    }
    else if (value !== null) {
      yield value;
    }
  }
}
