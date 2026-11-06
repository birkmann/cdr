import { describe, expect, it } from "vitest";
import { remoteLabel, remoteWebUrl, suggestRepoName } from "./publish";

describe("publishing to GitHub", () => {
  it("labels GitHub remotes the same way for HTTPS and SSH", () => {
    expect(remoteLabel("https://github.com/octo/snake.git")).toBe("github.com/octo/snake");
    expect(remoteLabel("git@github.com:octo/snake.git")).toBe("github.com/octo/snake");
    expect(remoteLabel("ssh://git@github.com/octo/snake")).toBe("github.com/octo/snake");
    expect(remoteWebUrl("git@github.com:octo/snake.git")).toBe("https://github.com/octo/snake");
  });

  it("never shows credentials embedded in a remote URL", () => {
    expect(remoteLabel("https://user:secret@gitlab.com/x/y.git")).toBe("https://gitlab.com/x/y");
    expect(remoteLabel("https://x-token@github.com/octo/snake.git")).toBe("github.com/octo/snake");
    expect(remoteWebUrl("https://gitlab.com/x/y")).toBeUndefined();
  });

  it("suggests a repository name from the folder", () => {
    expect(suggestRepoName("snake-2f7a3b", true)).toBe("snake");
    expect(suggestRepoName("create-a-snake-game-in-the-brows-1d7ee7", true)).toBe(
      "create-a-snake-game-in-the-brows",
    );
    expect(suggestRepoName("snake-2f7a3b")).toBe("snake-2f7a3b");
    expect(suggestRepoName("My Project (v2)")).toBe("My-Project-v2");
    expect(suggestRepoName("...")).toBe("project");
  });
});
