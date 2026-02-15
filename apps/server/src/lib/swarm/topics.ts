import { Topic } from "@ethersphere/bee-js";

/**
 * Feed topic helpers.
 * IMPORTANT: These strings are stable - changing them changes the feed address.
 */

const EVENT_NS = "woco/event";
const POD_NS = "woco/pod";

export const topicEventDirectory = () =>
  Topic.fromString(`${EVENT_NS}/directory`);

export const topicEvent = (eventId: string) =>
  Topic.fromString(`${EVENT_NS}/${eventId}`);

export const topicEditions = (seriesId: string) =>
  Topic.fromString(`${POD_NS}/editions/${seriesId}`);

export const topicClaims = (seriesId: string) =>
  Topic.fromString(`${POD_NS}/claims/${seriesId}`);

export const topicClaimers = (seriesId: string) =>
  Topic.fromString(`${POD_NS}/claimers/${seriesId}`);

export const topicUserCollection = (ethAddress: string) =>
  Topic.fromString(`${POD_NS}/collection/${ethAddress.toLowerCase()}`);

export const topicCreator = (creatorPodKey: string) =>
  Topic.fromString(`${POD_NS}/creator/${creatorPodKey}`);
