import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { nextEpisodeFrom } from "../../../lib/media/next-episode.js";

describe("nextEpisodeFrom", () => {
  it("increments episode when mid-season", () => {
    assert.deepEqual(
      nextEpisodeFrom({ season: 2, episode: 4, seasonEpisodeCount: 23, seasonCount: 3 }),
      { season: 2, episode: 5 },
    );
  });

  it("rolls over to next season at season finale", () => {
    assert.deepEqual(
      nextEpisodeFrom({ season: 1, episode: 12, seasonEpisodeCount: 12, seasonCount: 3 }),
      { season: 2, episode: 1 },
    );
  });

  it("returns null at series finale", () => {
    assert.equal(
      nextEpisodeFrom({ season: 3, episode: 10, seasonEpisodeCount: 10, seasonCount: 3 }),
      null,
    );
  });

  it("treats seasonEpisodeCount=0 as unknown (regression: S2E4 wrongly jumped to S3E1)", () => {
    // Player.tsx coerces missing metadata to 0; that must NOT trigger season rollover.
    assert.deepEqual(
      nextEpisodeFrom({ season: 2, episode: 4, seasonEpisodeCount: 0, seasonCount: 0 }),
      { season: 2, episode: 5 },
    );
  });

  it("treats missing seasonEpisodeCount as unknown", () => {
    assert.deepEqual(
      nextEpisodeFrom({ season: 1, episode: 3 }),
      { season: 1, episode: 4 },
    );
  });

  it("rolls over when episode count is known but seasonCount unknown", () => {
    assert.deepEqual(
      nextEpisodeFrom({ season: 1, episode: 12, seasonEpisodeCount: 12 }),
      { season: 2, episode: 1 },
    );
  });
});
