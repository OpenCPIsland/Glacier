// "room.igloo_updated" is only broadcast from the sender's own igloo. A room
// name is "world:language:room:instance:content"; ownership is the world
// "Igloo" and the sender's swid in the instance field, compared exactly.
import { ownsIglooRoom } from "../smartfox-server/src/handlers/igloo.ts";
import { makeChecker } from "./lib/harness.ts";

const { check, finish } = makeChecker();
const ME = "{AAAAAAAA-1111-2222-3333-444444444444}";
const OTHER = "{BBBBBBBB-1111-2222-3333-444444444444}";
const V = "1.17.0;live;2026-11-11;NONE";

check(ownsIglooRoom(`Igloo:en_US:DefaultIgloo:${ME}:${V}`, ME), "the owner is in their own igloo");
check(!ownsIglooRoom(`Igloo:en_US:DefaultIgloo:${OTHER}:${V}`, ME), "a visitor is not in their own igloo");
check(!ownsIglooRoom(`Iceberg:en_US:Town::${V}`, ME), "a public room is nobody's igloo");
check(!ownsIglooRoom(`${ME}:en_US:Town::${V}`, ME), "a world named like the swid is not ownership");
check(!ownsIglooRoom(`Iceberg:${ME}:Town::${V}`, ME), "a language named like the swid is not ownership");
check(!ownsIglooRoom(`Iceberg:en_US:${ME}::${V}`, ME), "a room named like the swid is not ownership");
check(!ownsIglooRoom(`Iceberg:en_US:Town:${ME}:${V}`, ME), "the swid as the instance of a non-igloo world is not ownership");
check(!ownsIglooRoom(`Igloo:en_US:DefaultIgloo:${OTHER}${ME}:${V}`, ME), "a longer instance containing the swid is not ownership");
check(!ownsIglooRoom("", ME) && !ownsIglooRoom("ClubPenguin_default_room", ME), "empty and default room names are nobody's igloo");
finish("");
