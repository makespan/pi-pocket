import assert from "node:assert/strict";
import { test } from "node:test";
import { download } from "../src/server/gallery/fetch.ts";

test("an encoded response may have a wire length above the decoded size limit", async () => {
    const bytes = await download(
        async () =>
            new Response("good", {
                headers: { "content-encoding": "gzip", "content-length": "51" },
            }),
        "https://example.com/file",
        4,
        "file",
    );

    assert.equal(new TextDecoder().decode(bytes), "good");
});

test("an encoded response is still rejected when its decoded body exceeds the limit", async () => {
    await assert.rejects(
        download(
            async () =>
                new Response("large", {
                    headers: { "content-encoding": "gzip", "content-length": "51" },
                }),
            "https://example.com/file",
            4,
            "file",
        ),
        /file is larger than 4 bytes/,
    );
});

/** A fetcher that records each request's address and authorization header, and answers from `answer`. */
function recorder(answer: (url: string) => Response) {
    const seen: { url: string; authorization: string | null }[] = [];
    const fetcher = async (url: string, init: RequestInit) => {
        seen.push({ url, authorization: new Headers(init.headers).get("authorization") });

        return answer(url);
    };

    return { seen, fetcher };
}

test("a GitHub token goes to GitHub's hosts", async () => {
    const { seen, fetcher } = recorder(() => new Response("ok"));

    for (const url of [
        "https://raw.githubusercontent.com/acme/index/HEAD/index.json",
        "https://api.github.com/repos/acme/index",
        "https://github.com/acme/index",
    ]) {
        await download(fetcher, url, 10, "file", { token: "ghp_secret" });
    }

    assert.deepEqual(
        seen.map((each) => each.authorization),
        ["Bearer ghp_secret", "Bearer ghp_secret", "Bearer ghp_secret"],
    );
});

test("a GitHub token never goes to another host, also not after a redirect", async () => {
    const { seen, fetcher } = recorder((url) =>
        url.startsWith("https://raw.githubusercontent.com/")
            ? new Response(null, {
                  status: 302,
                  headers: { location: "https://evil.example/steal" },
              })
            : new Response("ok"),
    );

    await download(fetcher, "https://example.com/index.json", 10, "file", { token: "ghp_secret" });
    await download(
        fetcher,
        "https://raw.githubusercontent.com/acme/index/HEAD/index.json",
        10,
        "file",
        {
            token: "ghp_secret",
        },
    );

    assert.deepEqual(seen, [
        { url: "https://example.com/index.json", authorization: null },
        {
            url: "https://raw.githubusercontent.com/acme/index/HEAD/index.json",
            authorization: "Bearer ghp_secret",
        },
        { url: "https://evil.example/steal", authorization: null },
    ]);
});

test("a GitHub look-alike host gets no token, and no token goes without one", async () => {
    const { seen, fetcher } = recorder(() => new Response("ok"));

    await download(fetcher, "https://raw.githubusercontent.com.evil.example/x", 10, "file", {
        token: "ghp_secret",
    });
    await download(fetcher, "https://raw.githubusercontent.com/acme/index/HEAD/x", 10, "file");

    assert.deepEqual(
        seen.map((each) => each.authorization),
        [null, null],
    );
});

test("a 404 from GitHub says how to read a private repository, and never shows the token", async () => {
    const { fetcher } = recorder(() => new Response("Not Found", { status: 404 }));
    const url = "https://raw.githubusercontent.com/acme/index/HEAD/index.json";

    await assert.rejects(
        download(fetcher, url, 10, "The index"),
        /give the gallery a GitHub token/,
    );
    await assert.rejects(
        download(fetcher, url, 10, "The index", { token: "ghp_secret" }),
        (error: Error) => {
            assert.match(error.message, /check that the GitHub token can read it/);
            assert.doesNotMatch(error.message, /ghp_secret/);

            return true;
        },
    );
    await assert.rejects(
        download(fetcher, "https://example.com/index.json", 10, "The index"),
        (error: Error) => {
            assert.doesNotMatch(error.message, /token/);

            return true;
        },
    );
});
