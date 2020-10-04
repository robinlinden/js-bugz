import { Context, Application, GitHubAPI } from "probot"; // eslint-disable-line no-unused-vars
import { Octokit } from "@octokit/rest";
import { IncomingMessage, ServerResponse } from "http";
import { WebhookPayloadIssues } from "@octokit/webhooks";
import { MongoClient, Collection, Db } from "mongodb";
import cheerio from "cheerio";

type Repository = Octokit.AppsListReposResponseRepositoriesItem;

interface IssueMetadata {
  canonicalId: number | null;
}

function newMetadata(): IssueMetadata {
  return {
    canonicalId: null,
  };
}

interface IssueBody {
  sections: string[];
  metadata: IssueMetadata;
}

interface Issue {
  owner: string;
  repo: string;
  issueId: number;
  body: IssueBody;
}

interface IssueContext {
  github: GitHubAPI;
  issue: Issue;
}

class State {
  async getIssuesFromGithub(github: GitHubAPI, owner: string, repo: string): Promise<Issue[]> {
    console.log("retrieving issues from GitHub for", owner + "/" + repo);
    const res = await github.paginate(
      github.issues.listForRepo.endpoint.merge({ owner, repo, state: "all" })
    );
    const issues = res.filter((issue) => !issue.pull_request);
    return issues.map((issue) => ({
      owner,
      repo,
      issueId: issue.number,
      body: parseIssueBody(issue.body),
    }));
  }

  async getIssuesforRepo(
    github: GitHubAPI,
    collection: Collection,
    repository: Repository
  ): Promise<IssueContext[]> {
    const owner = repository.owner.login;
    const repo = repository.name;

    if (repo === "experimental") {
      // Delete all issues from the cache for the experimental repo so we always
      // exercise the github retrieval code.
      await collection.deleteMany({ owner, repo });
    }

    // Check if our cache knows about this repo yet.
    const existing = await collection.find({ owner, repo }).toArray();
    if (existing.length !== 0) {
      //console.log("found", existing.length, "issues in db for", owner + "/" + repo);
      return existing.map((issue) => ({ github, issue }));
    }

    // Ensure that we have a unique index on the issues in the db.
    await collection.createIndexes([{ key: { owner: 1, repo: 1, issueId: 1 }, unique: true }]);

    // Get all issues from GitHub.
    const issues = await this.getIssuesFromGithub(github, owner, repo);
    if (issues.length === 0) {
      // No issues, nothing to do here.
      console.log("no issues found for", owner + "/" + repo);
      return [];
    }

    const contexts = issues.map((issue) => ({ github, issue }));

    // Insert the issues we loaded from github.
    await collection.insertMany(issues);

    //await context.github.issues.update(context.issue({ body: printIssueBody(body) }));
    console.log("found", contexts.length, "issues on GitHub for", owner + "/" + repo);
    return contexts;
  }

  async getIssues(app: Application, db: Db): Promise<IssueContext[]> {
    console.log("initialising database");
    const github = await app.auth();
    const installations = await github.apps.listInstallations();
    const collection = db.collection("issues");
    const issues = await Promise.all(
      installations.data.map(
        async (installation): Promise<IssueContext[]> => {
          console.log("fetching repositories for installation");
          const github = await app.auth(installation.id);
          const response = await github.apps.listRepos();
          return await Promise.all(
            response.data.repositories.map((r) => this.getIssuesforRepo(github, collection, r))
          ).then(flatten);
        }
      )
    ).then(flatten);
    return issues;
  }

  async initialise(app: Application, db: Db): Promise<void> {
    const contexts = await this.getIssues(app, db);

    if (contexts.length === 0) {
      console.log("no issues found");
      return;
    }
    console.log("found", contexts.length, "issues");
    app.log.trace("first issue found:", contexts[0].issue);
    const knownIds = contexts
      .map((context) => context.issue.body.metadata.canonicalId || 0)
      .filter((m) => m !== 0)
      .sort();

    // If there are any gaps in the canonical number space, we find them here.
    const gaps = findGaps(knownIds, contexts.length);
    console.log(gaps);

    // Next, we assign a canonical number to all issues that don't yet have one.
    // We start with the gaps and then increment from there.
    let nextId = 0;
    for (let context of contexts) {
      if (context.issue.body.metadata.canonicalId) {
        // This issue already has a canonical ID.
        continue;
      }
      if (gaps.length !== 0) {
        nextId = gaps[gaps.length - 1];
        gaps.pop();
      } else {
        nextId++;
      }
      context.issue.body.metadata.canonicalId = nextId;
    }

    //const updates = [];
    console.log(knownIds);
    console.log("ok");
  }

  async addIssue(context: Context<WebhookPayloadIssues>) {
    const issueComment = {
      repo: context.issue().repo,
      owner: context.issue().owner,
      issue_number: context.issue().number,
      body: "Thanks for opening this issue!",
    };
    await context.github.issues.createComment(issueComment);
    if (false) {
      const issue = await context.github.issues.get(context.issue()).then((r) => r.data);
      const body = parseIssueBody(issue.body);
      await context.github.issues.update(context.issue({ body: printIssueBody(body) }));
    }
  }
}

function flatten<T>(array: T[][]): T[] {
  const res = [];
  for (let x of array) {
    res.push(...x);
  }
  return res;
}

/**
 * Given a sorted array of numbers, find all the numbers between 1 and the last
 * element of the array, but no more than maxGaps.
 *
 * This means we'll never try to find more gaps than there are bugs. E.g. if the
 * last element is 4,000,000,000 but we only have 500 bugs, then we'll find 500
 * gaps and don't loop ~forever in this function.
 */
function findGaps(array: number[], maxGaps: number) {
  // O(n^2) but shouldn't actually happen in production unless people mess with
  // their issue text and change the canonical ID there.
  while (array.length !== 0 && array[0] < 1) {
    array.shift();
  }

  const gaps = [];
  let arrayIndex = 0;
  for (let i = 1; i < array[array.length - 1]; i++) {
    if (i == array[arrayIndex]) {
      arrayIndex++;
    } else {
      gaps.push(i);
    }
    if (gaps.length == maxGaps) {
      break;
    }
  }
  return gaps;
}

const DO_NOT_EDIT = "<!-- DO NOT EDIT -->\r\n";
const SEPARATOR = "\r\n---\r\n";

function parseMetadata(html: string): IssueMetadata | null {
  const $ = cheerio.load(html);

  const details = $("details > ul > li");
  if (details.length == 0) {
    return null;
  }

  const metadata = newMetadata();
  details.each((_, li) => {
    const data = $(li).data();
    if ("canonicalId" in data) metadata.canonicalId = parseInt(data.canonicalId);
  });

  if (metadata.canonicalId !== null && (isNaN(metadata.canonicalId) || metadata.canonicalId < 1)) {
    // Invalid number => make it null.
    metadata.canonicalId = null;
  }

  return metadata;
}

function printMetadata(metadata: IssueMetadata | null): string | null {
  if (!metadata) {
    return null;
  }

  const $ = cheerio.load("");
  const details = $("<ul>");
  const addField = (
    name: string,
    value: any | null,
    text: string,
    f?: (li: cheerio.Cheerio) => cheerio.Cheerio
  ) => {
    if (!f) f = (li) => li;
    if (value !== null) {
      details.append(
        f(
          $("<li>")
            .attr("data-" + name, value.toString())
            .text(text)
        )
      );
    }
  };

  addField("canonical-id", metadata.canonicalId, "Canonical link: ", (li) =>
    li.append($("<a>").text(""))
  );

  return $("body")
    .append($("<details>").append($("<summary>").text("Issue metadata")).append(details))
    .html();
}

function parseIssueBody(bodyText: string): IssueBody {
  const sections = bodyText.split(SEPARATOR);
  const last = sections[sections.length - 1];

  const metadata = last ? parseMetadata(last) : null;
  if (metadata) {
    sections.pop();
  }

  // Make sure we always have an empty metadata.
  return { sections, metadata: metadata ? metadata : newMetadata() };
}

function printIssueBody(body: IssueBody): string {
  const sections = body.sections.slice();
  const metadataSection = printMetadata(body.metadata);
  if (metadataSection) {
    sections.push(DO_NOT_EDIT + metadataSection);
  }
  return sections.join(SEPARATOR);
}

export = async (app: Application) => {
  const state = new State();

  if (false) {
    await withMongo(async (db) => {
      await state.initialise(app, db);
    });
  }

  app.route("/b").use((req: IncomingMessage, res: ServerResponse, next: (err?: any) => void) => {
    const num = parseInt(req.url!.substr(1));
    if (isNaN(num)) {
      res.writeHead(404);
      res.end("Invalid request to bug redirector: " + req.url);
      return next();
    }

    const issueUrl = "https://github.com/TokTok/experimental/issues/23";
    res.writeHead(301, { location: issueUrl });
    res.end("Redirecting to " + issueUrl);
    console.log(num);
    return next();
  });

  app.on("issues.opened", async (context) => {
    await state.addIssue(context);
  });
};

async function withMongo(f: (db: Db) => Promise<void>): Promise<void> {
  const mongoUser = "toktok";
  const mongoPass = process.env.MONGODB_PASS;

  const uri =
    "mongodb+srv://" +
    mongoUser +
    ":" +
    mongoPass +
    "@toktok-mpawa.mongodb.net/test?retryWrites=true&w=majority";

  const client = await MongoClient.connect(uri, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  });
  const db = client.db("github");
  await f(db);
  // perform actions on the collection object
  client.close();
}
