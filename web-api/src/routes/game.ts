/**
 * Game Routes
 * 
 * Handles room joining, session management, and room population queries.
 * 
 * Endpoints:
 * - GET  /game/v1/rooms                                              - List available rooms
 * - POST /game/v1/worlds/:world/language/:language/rooms/:room/players - Join a room
 * - POST /game/v1/igloos/language/:language/players                  - Join an igloo
 * - DELETE /game/v1/session/:sessionId                               - End session / leave room
 * - GET  /game/v1/roomPopulation/:world                              - Get room populations for a world
 * - GET  /game/v1/world/roomPopulation/:room                         - Get room population across worlds
 */

import express from "express";
const router = express.Router();
import * as db from "../database.ts";
import config from "../config.ts";
import { saveSessionForUser, generateSessionId } from "../utils/session.ts";
import { QuestStatus } from "../utils/response.ts";
import { signJoin } from "../utils/joinSignature.ts";
import lots from "../../data/lots.json";
import { logSafe } from "../utils/logSafe.ts";
import { buildContentIdentifier, todayUtc } from "../utils/contentIdentifier.ts";
import { roomCap, populationScaleFor, isMarkedFull } from "../utils/roomCap.ts";
import { effectiveRole } from "../utils/staffRoles.ts";

/** Moderators and admins get into a full room (to moderate a crowd). */
function isCapExempt(swid) {
    const row = db.getPlayerIdentityAndRole(swid);
    if (!row) return false;
    const role = effectiveRole(row.username, row.role);
    return role === 'moderator' || role === 'admin';
}

/**
 * ErrorResponse code 1000 is CP_ROOM_FULL. For a room the client retries the
 * same room without a world (GET /game/v1/rooms picks one with space); for
 * an igloo it shows its igloo-full prompt. Not 401: the client treats that
 * as an expired token.
 */
const roomFull = (res) => res.status(409).json({ code: 1000 });

// ========== CONSTANTS ==========

/**
 * Available game worlds (the client's "servers"). A client that doesn't name
 * a world asks GET /game/v1/rooms and joins the first entry, so the first
 * world here is the one new joins land in. Players can pick any world from
 * the client's own list; worlds are separate rooms on the game server.
 */
const DEFAULT_WORLD = 'Iceberg';
const AVAILABLE_WORLDS = [DEFAULT_WORLD, 'Alpine', 'Blizzard', 'Glacier', 'Summit'];

/**
 * World, language and room names sit inside the signed room identifier
 * ("world:language:room:instance:content"), which the game server splits on
 * ":" and matches rooms by. The client chooses them, so they are held to
 * plain shapes: no ":", ";", braces (a swid is "{...}", and the game server
 * must never find one in a field the player picked) or control characters.
 * Worlds are the client's server names ("Iceberg", "Cream Soda",
 * "Glaci\u00e8re"). "Igloo" is the world of igloos and is joined through the
 * igloo route only.
 */
const WORLD_NAME = /^[\p{L}\p{N}][\p{L}\p{N} '.-]{0,29}$/u;
const ROOM_NAME = /^[A-Za-z0-9_]{1,40}$/;
const LANGUAGE_NAME = /^[A-Za-z]{2,3}([_-][A-Za-z]{2,4})?$/;
const isWorldName = (name) => typeof name === 'string' && WORLD_NAME.test(name) && name.toLowerCase() !== 'igloo';
const isRoomName = (name) => typeof name === 'string' && ROOM_NAME.test(name);
const isLanguageName = (name) => typeof name === 'string' && LANGUAGE_NAME.test(name);

/**
 * The client's non-igloo zones (ZoneName of its zone definitions). Room
 * populations are reported for these. Igloos have their own routes.
 */
const AVAILABLE_ROOMS = [
    'Town', 'Boardwalk', 'Beach', 'MtBlizzard', 'MtBlizzardSummit', 'Diving',
    'TownInterior', 'DotsShop', 'HerbertBase', 'BoxDimension',
    'EventMedievalDungeon1', 'EventPirateParty'
];

/**
 * Language code mapping
 * Client sends language as integer enum
 */
const LANGUAGE_MAP = {
    'en': 1,
    'en_US': 1,
    'pt': 2,
    'pt_BR': 2,
    'fr': 3,
    'fr_FR': 3,
    'es': 4,
    'es_LA': 4
};

// ========== HELPER FUNCTIONS ==========

/**
 * Build content identifier string
 */
export { buildContentIdentifier, todayUtc };

/**
 * The caller's client version, from the X-CP-Client-Version header every
 * CP API request carries. It goes into the signed room name, and the game
 * server keys rooms by that name, so different client versions never share
 * a room. Anything but 1-4 dot-separated numbers gets the default.
 */
export function clientVersionOf(req) {
    const v = req.headers?.['x-cp-client-version'];
    return typeof v === 'string' && /^\d{1,6}(\.\d{1,6}){0,3}$/.test(v) ? v : config.content.clientVersion;
}

/**
 * Build room identifier string
 * Format: world:language:roomName:instanceId:contentIdentifier
 */
function buildRoomIdentifier(world, language, roomName, instanceId = '', clientVersion = undefined) {
    return `${world}:${language}:${roomName}:${instanceId}:${buildContentIdentifier(clientVersion)}`;
}

/**
 * Get language integer from string
 */
function getLanguageInt(languageStr) {
    return LANGUAGE_MAP[languageStr] || 1;
}

/**
 * RoomPopulationScale as a number, 0 (ZERO) to 5 (FIVE). It has to be a
 * number: the client reads the JSON with LitJson, which turns a number
 * into the enum but refuses the name ("ZERO"), and Disney's own server
 * answers with numbers. FIVE is "full" (ROOM_CAP): the client's server
 * list won't switch into a world showing it (utils/roomCap.ts).
 * @param {number} count - Players in the room
 * @returns {number} 0 to 5
 */
export function getPopulationScale(count) {
    return populationScaleFor(count, roomCap());
}

/**
 * Get the mascot level based on internal XP
 * Level is calculated as floor(internalXP / 1,000,000)
 * This matches the reference implementation: ProgressionService.GetMascotLevelFromXP
 * @param {string} mascotName - Mascot name (e.g., 'AuntArctic')
 * @param {number} xp - Internal XP amount (1,000,000 per level)
 * @returns {number} Current level (0+)
 */
function getMascotLevel(mascotName, xp) {
    // Level = internal XP / 1,000,000 (floored)
    return Math.floor((xp || 0) / 1000000);
}

/**
 * Build the complete quest state collection including available quests
 * @param {string} username - Player username
 * @param {Array} existingQuests - Quests from database
 * @param {object} mascotXP - Player's mascot XP object
 * @returns {Array} Complete quest state collection
 */
function buildCompleteQuestCollection(username, existingQuests, mascotXP) {
    const existingQuestIds = new Set(existingQuests.map(q => q.questId));
    
    // Build a map of completed quests
    const completedQuests = new Set();
    for (const quest of existingQuests) {
        if (quest.status === QuestStatus.COMPLETED || quest.timesCompleted > 0) {
            completedQuests.add(quest.questId);
        }
    }
    
    // Start with existing quests
    const allQuests = [...existingQuests];
    
    // Check each quest definition to see if it should be available
    for (const [questId, questDef] of Object.entries(config.questDefinitions || {})) {
        // Skip if already in database
        if (existingQuestIds.has(questId)) {
            continue;
        }
        
        // Check level requirement
        const mascotXpAmount = mascotXP[questDef.mascot] || 0;
        const playerLevel = getMascotLevel(questDef.mascot, mascotXpAmount);
        
        if (playerLevel < questDef.levelRequirement) {
            // Player doesn't meet level requirement - quest is locked
            continue;
        }
        
        // Check prerequisites
        let prerequisitesMet = true;
        for (const prereq of questDef.prerequisites || []) {
            if (!completedQuests.has(prereq)) {
                prerequisitesMet = false;
                break;
            }
        }
        
        if (prerequisitesMet) {
            // Quest is available - add it with AVAILABLE status
            allQuests.push({
                questId: questId,
                status: QuestStatus.AVAILABLE,
                completedObjectives: [],
                timesCompleted: 0,
                unlockTime: null,
                completedTime: null
            });
        }
    }
    
    return allQuests;
}

/**
 * Build JoinRoomData structure for room join response
 */
function buildJoinRoomData(swid, username, displayName, sessionId, roomIdentifier, playerProgress, extraOptions = {}) {
    const profile = playerProgress.profile || { colour: 3235500, daysOld: 1 };

    // Resolve outfit parts (IDs to Objects)
    const equippedIds = playerProgress.outfit?.parts || [];
    const allEquipment = playerProgress.equipment || [];
    const outfitEquipment = allEquipment.filter(eq => equippedIds.includes(eq.equipmentId));
    
    // Build complete quest collection including available quests
    const mascotXP = playerProgress.mascotXP || {};
    const quests = buildCompleteQuestCollection(username, playerProgress.quests || [], mascotXP);

    return {
        swid: swid,
        host: config.gameServer.ip,
        tcpPort: config.gameServer.tcpPort,
        httpsPort: config.gameServer.httpsPort,
        room: roomIdentifier,
        sessionId: sessionId,
        playerRoomData: {
            assets: playerProgress.assets,
            consumableInventory: playerProgress.consumableInventory || { inventoryMap: {} },
            dailyTaskProgress: playerProgress.dailyTaskProgress || [],
            member: true,
            outfit: { 
                parts: outfitEquipment,
                sessionId: sessionId
            },
            profile: profile,
            quests: quests
        },
        earnedRewards: extraOptions.earnedRewards || {},
        userName: displayName,
        membershipRights: { 
            swid: swid,
            member: true,
            recurring: false,
            recurDate: 0,
            expireDate: Date.now() + 1000000000
        },
        // The client re-reads its equipped tube from here on every join.
        selectedTubeId: db.getEquippedTube(username),
        roomOwnerName: extraOptions.roomOwnerName || '',
        roomOwner: extraOptions.roomOwner || false,
        extraLayoutData: extraOptions.extraLayoutData || null
    };
}

/**
 * Wrap response in SignedResponse format
 */
function signedResponse(data, swid) {
    return {
        goodUntil: Date.now() + 3600000, // 1 hour
        swid: swid,
        data: data,
        signature: 'server_signature'
    };
}

/**
 * SignedResponse for joinRoomData. The client passes it unchanged to the
 * SmartFox login, and SmartFox checks this signature (utils/joinSignature.ts)
 * before trusting the swid, sessionId, room and userName in it.
 */
function signedJoinResponse(joinRoomData, swid) {
    const goodUntil = Date.now() + 3600000; // 1 hour
    return {
        goodUntil,
        swid,
        data: joinRoomData,
        signature: signJoin(swid, joinRoomData.sessionId, joinRoomData.room, goodUntil, joinRoomData.userName)
    };
}

// ========== ROUTES ==========

/**
 * GET /game/v1/rooms
 * List available rooms
 * 
 * Query params:
 * - language: Language code (e.g., 'en')
 * - worlds: Comma-separated list of worlds to check
 * - rooms: Comma-separated list of rooms to check
 * - limit: Max results (optional)
 * 
 * Response: RoomIdentifier[]
 */
router.get('/game/v1/rooms', (req, res) => {
    const { language, worlds, rooms, limit } = req.query;
    
    console.log(`[GET ROOMS] language=${language}, worlds=${worlds}, rooms=${rooms}, limit=${limit}`);
    
    // Parse world and room filters. They're client text: repeats collapse and
    // each list is capped (200 worlds, as the population lists; 50 rooms, the
    // client has 12), so one request can't ask for millions of rooms.
    const worldFilter = worlds ? [...new Set(worlds.split(',').map(w => w.trim()).filter(isWorldName))].slice(0, 200) : AVAILABLE_WORLDS;
    const roomFilter = rooms ? [...new Set(rooms.split(',').map(r => r.trim()).filter(isRoomName))].slice(0, 50) : AVAILABLE_ROOMS;
    const resultLimit = limit ? parseInt(limit) : 0;
    const clientVersion = clientVersionOf(req);
    const contentIdentifier = buildContentIdentifier(clientVersion);
    // A room-full join is retried through here without a world, and the
    // client joins the first result, so full rooms are left out: the retry
    // lands in the first world (in AVAILABLE_WORLDS order) with space, and an
    // empty list is the client's "no rooms" error.
    const cap = roomCap();
    const occupancy = db.getPublicRoomOccupancy(clientVersion);

    // Build RoomIdentifier list
    const roomIdentifiers = [];
    const languageInt = getLanguageInt(language || 'en');
    
    for (const world of worldFilter) {
        for (const room of roomFilter) {
            // Skip if we've hit the limit
            if (resultLimit > 0 && roomIdentifiers.length >= resultLimit) {
                break;
            }
            if ((occupancy.get(`${world}\n${room}`) ?? 0) >= cap || isMarkedFull(world, room, '', clientVersion)) continue;

            roomIdentifiers.push({
                world: world,
                language: languageInt,
                zoneId: {
                    name: room,
                    instanceId: ''
                },
                contentIdentifier
            });
        }
        
        if (resultLimit > 0 && roomIdentifiers.length >= resultLimit) {
            break;
        }
    }
    
    res.json(roomIdentifiers);
});

/**
 * POST /game/v1/worlds/:world/language/:language/rooms/:room/players
 * Join a room - returns game server connection info
 * 
 * Response: SignedResponse<JoinRoomData>
 */
router.post('/game/v1/worlds/:world/language/:language/rooms/:room/players', (req, res) => {
    const { world, language, room } = req.params;
    const { bypassCaptcha } = req.query;
    const { swid, username } = req.player;

    if (!isWorldName(world) || !isLanguageName(language) || !isRoomName(room)) {
        return res.status(400).json({ error: 'Invalid world, language or room name.' });
    }
    
    // Check if player is authenticated and exists
    if (!username) {
        console.error(`[JOIN ROOM] Player not found for SWID: ${swid}`);
        return res.status(401).json({ error: 'Player not found. Please register or login.' });
    }
    
    const sessionId = generateSessionId();
    const clientVersion = clientVersionOf(req);

    // Get display name from identity
    const playerIdentity = db.getPlayerBySwid(swid);
    const displayName = playerIdentity?.displayName || username;

    // The count and registerPlayerSession below run without an await in
    // between (bun:sqlite is synchronous), so two joins can't both take the
    // room's last place.
    if (!isCapExempt(swid) && (isMarkedFull(world, room, '', clientVersion)
        || db.countRoomOccupants(world, room, '', clientVersion, swid) >= roomCap())) {
        console.log(`[JOIN ROOM] ${displayName} refused: ${room} in ${world} is full (client ${clientVersion})`);
        return roomFull(res);
    }

    console.log(`[JOIN ROOM] ${displayName} (swid=${swid}) joining ${room} in ${world} (client ${clientVersion})`);

    // Save session for SFS2X file-based integration
    saveSessionForUser(username, sessionId, room);

    // Register session in database for player lookups
    console.log(`[JOIN ROOM] Registering session for SWID=${swid}, sessionId=${sessionId}, room=${room}`);
    db.registerPlayerSession(swid, sessionId, room, world, '', clientVersion);
    
    // Load player data from database
    const playerProgress = db.getFullPlayerData(username);
    
    // Check if player data was loaded successfully
    if (!playerProgress) {
        console.error(`[JOIN ROOM] Failed to load player data for ${username}`);
        return res.status(500).json({ error: 'Failed to load player data.' });
    }

    // Build room identifier
    const roomIdentifier = buildRoomIdentifier(world, language, room, '', clientVersion);

    // Build join room response
    const joinRoomData = buildJoinRoomData(
        swid, 
        username, 
        displayName, 
        sessionId, 
        roomIdentifier, 
        playerProgress
    );

    res.json(signedJoinResponse(joinRoomData, swid));
});

/**
 * POST /game/v1/igloos/language/:language/players
 * Join an igloo
 * 
 * Request body: ZoneId (igloo identifier) - { name, instanceId }
 * Response: SignedResponse<JoinRoomData>
 */
router.post('/game/v1/igloos/language/:language/players', (req, res) => {
    const { language } = req.params;
    const { bypassCaptcha } = req.query;
    const iglooId = req.body; // ZoneId: { name, instanceId }
    const { swid, username } = req.player;

    if (!isLanguageName(language)) {
        return res.status(400).json({ error: 'Invalid language.' });
    }
    
    const sessionId = generateSessionId();
    
    // Get display name from identity
    const playerIdentity = db.getPlayerBySwid(swid);
    const displayName = playerIdentity?.displayName || username;
    
    // Determine igloo zone name and owner
    const iglooZoneName = iglooId?.name || 'DefaultIgloo';
    const iglooOwnerId = iglooId?.instanceId || swid; // instanceId is the owner's SWID
    
    console.log(`[JOIN IGLOO] ${displayName} (swid=${swid}) joining igloo ${logSafe(iglooZoneName)} owned by ${logSafe(iglooOwnerId)}`);

    // The owner's visibility setting (IglooVisibility: 0 private, 1 friends
    // only, 2 public). ErrorResponse code 1010 is CP_IGLOO_UNAVAILABLE: the
    // client reports a private igloo and returns to the previous room.
    const refuse = (why) => {
        console.log(`[JOIN IGLOO] ${displayName} refused: ${why}`);
        return res.status(403).json({ code: 1010 });
    };
    if (typeof iglooZoneName !== 'string' || !Object.hasOwn(lots, iglooZoneName)) return refuse('not an igloo lot');
    if (typeof iglooOwnerId !== 'string') return refuse('no owner');
    if (iglooOwnerId !== swid) {
        const owner = db.getPlayerBySwid(iglooOwnerId);
        if (!owner) return refuse('unknown owner');
        const visibility = db.getIglooData(owner.username)?.visibility ?? 1;
        const isFriend = () => db.getMixFriendships(iglooOwnerId).some((f) => f.friendUserId === swid);
        if (visibility === 0) return refuse('private igloo');
        if (visibility !== 2 && !isFriend()) return refuse('friends-only igloo');
    }
    
    // Use "Igloo" as the world name for igloos
    let iglooWorld = 'Igloo';

    // A full igloo refuses visitors (the client shows its igloo-full
    // prompt); the owner and staff always get in. No await between this
    // count and registerPlayerSession.
    const clientVersion = clientVersionOf(req);
    if (iglooOwnerId !== swid && !isCapExempt(swid)
        && (isMarkedFull('Igloo', iglooZoneName, iglooOwnerId, clientVersion)
            || db.countRoomOccupants('Igloo', iglooZoneName, iglooOwnerId, clientVersion, swid) >= roomCap())) {
        console.log(`[JOIN IGLOO] ${displayName} refused: igloo of ${logSafe(iglooOwnerId)} is full`);
        return roomFull(res);
    }

    // Save session for SFS2X file-based integration
    saveSessionForUser(username, sessionId, iglooZoneName);

    // Register session in database
    db.registerPlayerSession(swid, sessionId, iglooZoneName, 'Igloo', iglooOwnerId, clientVersion);

    // Load player data
    const playerProgress = db.getFullPlayerData(username);

    // Build room identifier for igloo
    const roomIdentifier = buildRoomIdentifier('Igloo', language, iglooZoneName, iglooOwnerId, clientVersion);

    // Determine if this is the player's own igloo
    const isOwnIgloo = (iglooOwnerId === swid);
    
    // Get igloo owner's data for layout
    let roomOwnerName = displayName;
    let extraLayoutData = null;
    
    if (isOwnIgloo) {
        // Get player's own igloo layout
        const iglooData = db.getIglooData ? db.getIglooData(username) : null;
        if (iglooData && iglooData.activeLayout) {
            extraLayoutData = iglooData.activeLayout;
        }
    } else {
        // Get igloo owner's data
        const ownerIdentity = db.getPlayerBySwid(iglooOwnerId);
        if (ownerIdentity) {
            roomOwnerName = ownerIdentity.displayName || ownerIdentity.username;
            // Get owner's igloo layout
            const ownerIglooData = db.getIglooData ? db.getIglooData(ownerIdentity.username) : null;
            if (ownerIglooData && ownerIglooData.activeLayout) {
                extraLayoutData = ownerIglooData.activeLayout;
            }
        }
    }
    
    // Build default layout if none exists
    if (!extraLayoutData) {
        extraLayoutData = {
            zoneId: 'DefaultIgloo',
            name: '',
            lightingId: 0,
            musicId: 0,
            decorationsLayout: [],
            extraInfo: {},
            createdDate: null,
            lastModifiedDate: null,
            memberOnly: false
        };
    }

    // Build join room response with igloo-specific options
    const joinRoomData = buildJoinRoomData(
        swid, 
        username, 
        displayName, 
        sessionId, 
        roomIdentifier, 
        playerProgress,
        {
            roomOwnerName: roomOwnerName,
            roomOwner: isOwnIgloo,
            extraLayoutData: extraLayoutData
        }
    );

    res.json(signedJoinResponse(joinRoomData, swid));
});

/**
 * DELETE /game/v1/session/:sessionId
 * End session / leave room
 * 
 * Response: Empty (204 No Content)
 */
router.delete('/game/v1/session/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const { swid } = req.player;
    
    console.log(`[END SESSION] swid=${swid} ending session ${sessionId}`);
    
    // Get session info before deletion
    const session = db.getSession(parseInt(sessionId));
    
    if (session) {
        // Verify session belongs to this player
        if (session.swid !== swid) {
            console.log(`[END SESSION] Unauthorized: session ${sessionId} belongs to ${session.swid}, not ${swid}`);
            return res.status(403).json({ error: 'Unauthorized to delete this session' });
        }
        
        // Delete the session
        db.deleteSession(parseInt(sessionId));
        console.log(`[END SESSION] Session ${sessionId} deleted for ${session.username}`);
    } else {
        console.log(`[END SESSION] Session ${sessionId} not found (may already be expired)`);
    }
    
    // Return 204 No Content on success
    res.status(204).send();
});

/**
 * GET /game/v1/roomPopulation/:world
 * Get room populations for a world
 * 
 * Query params:
 * - language: Language code
 * 
 * Response: GetRoomPopulationResponse { roomPopulations: RoomPopulation[] }
 */
router.get('/game/v1/roomPopulation/:world', (req, res) => {
    const { world } = req.params;
    const { language } = req.query;
    
    console.log(`[ROOM POPULATION] Querying populations for world=${world}, language=${language}`);
    
    // Only players on the caller's client version share its rooms, and each
    // world is its own set of rooms.
    const clientVersion = clientVersionOf(req);
    const sessions = db.getActiveSessionsByWorldAndRoom(clientVersion);
    const contentIdentifier = buildContentIdentifier(clientVersion);

    // Build room population list
    const roomPopulations = AVAILABLE_ROOMS.map(roomName => {
        const count = sessions.filter(s => s.world === world && s.room === roomName).reduce((n, s) => n + s.count, 0);
        const languageInt = getLanguageInt(language || 'en');
        
        return {
            identifier: {
                world: world,
                language: languageInt,
                zoneId: {
                    name: roomName,
                    instanceId: ''
                },
                contentIdentifier
            },
            populationScaled: getPopulationScale(count)
        };
    });
    
    res.json({
        roomPopulations: roomPopulations
    });
});

/**
 * GET /game/v1/world/roomPopulation/:room
 * Get room population across all worlds
 * 
 * Query params:
 * - language: Language code
 * 
 * Response: GetRoomPopulationForWorldsResponse { worldRoomPopulations: WorldRoomPopulation[] }
 */
router.get('/game/v1/world/roomPopulation/:room', (req, res) => {
    const { room } = req.params;
    const { language } = req.query;
    
    console.log(`[WORLD POPULATION] Querying population across worlds for room=${room}, language=${language}`);
    
    // Players in this room per world, among the caller's client version. The
    // known worlds are always listed; any other world someone is in is too.
    const inRoom = db.getActiveSessionsByWorldAndRoom(clientVersionOf(req)).filter(s => s.room === room && s.world !== 'Igloo');
    const worldNames = [...new Set([...AVAILABLE_WORLDS, ...inRoom.map(s => s.world).filter(isWorldName)])].slice(0, 200);

    const worldRoomPopulations = worldNames.map(worldName => ({
        worldName: worldName,
        populationScaled: getPopulationScale(inRoom.filter(s => s.world === worldName).reduce((n, s) => n + s.count, 0))
    }));
    
    res.json({
        worldRoomPopulations: worldRoomPopulations
    });
});

export default router;
