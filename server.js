/**
 * Blainville RP QC
 * Serveur Express, connexion Discord OAuth2, données du téléphone
 * et signalisation des appels individuels/de groupe.
 *
 * Node.js 18+
 * Démarrage : npm start
 *
 * Variables requises pour la connexion Discord :
 * DISCORD_CLIENT_ID
 * DISCORD_CLIENT_SECRET
 * DISCORD_REDIRECT_URI
 * SESSION_SECRET
 *
 * Variables facultatives :
 * DISCORD_TOKEN
 * GUILD_ID
 * DATA_DIR
 * PORT
 */

'use strict';

require('dotenv').config();

const path = require('path');
const http = require('http');
const express = require('express');
const cors = require('cors');
const session = require('express-session');
const crypto = require('crypto');
const fs = require('fs');
const WebSocket = require('ws');
const { Client, GatewayIntentBits } = require('discord.js');

const app = express();
const isProduction = process.env.NODE_ENV === 'production';

const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
const accountDataFile = path.join(dataDir, 'discord-phone-data.json');

app.set('trust proxy', 1);

app.use(cors({
    origin: true,
    credentials: true
}));

app.use(express.json({ limit: '256kb' }));

app.use(session({
    name: 'blainville.sid',
    secret: process.env.SESSION_SECRET ||
        'CHANGE-ME-TO-A-LONG-RANDOM-SECRET-BEFORE-DEPLOYING',
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure: isProduction,
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000
    }
}));

app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'roleplay.html'));
});

// ======================================================
// CONNEXION DISCORD OAUTH2
// ======================================================

const DISCORD_API = 'https://discord.com/api/v10';

const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DISCORD_REDIRECT_URI = process.env.DISCORD_REDIRECT_URI;

// ======================================================
// SAUVEGARDE DES DONNÉES PAR COMPTE DISCORD
// ======================================================

function getAccountData() {
    try {
        if (!fs.existsSync(accountDataFile)) {
            return {};
        }

        const parsed = JSON.parse(
            fs.readFileSync(accountDataFile, 'utf8')
        );

        return parsed && typeof parsed === 'object'
            ? parsed
            : {};
    } catch (error) {
        console.error(
            'Lecture des données impossible :',
            error.message
        );

        return {};
    }
}

function saveAccountData(data) {
    fs.mkdirSync(dataDir, { recursive: true });

    const temporaryFile = `${accountDataFile}.tmp`;

    fs.writeFileSync(
        temporaryFile,
        JSON.stringify(data, null, 2),
        'utf8'
    );

    fs.renameSync(temporaryFile, accountDataFile);
}

function requireDiscordLogin(req, res, next) {
    if (
        req.session &&
        req.session.discordUser &&
        req.session.discordUser.id
    ) {
        return next();
    }

    return res.status(401).json({
        error: 'Connexion Discord requise.'
    });
}

// Démarrer la connexion Discord.
app.get('/auth/discord', (req, res) => {
    if (
        !DISCORD_CLIENT_ID ||
        !DISCORD_CLIENT_SECRET ||
        !DISCORD_REDIRECT_URI
    ) {
        return res.status(500).send(
            'Connexion Discord non configurée. Vérifie ' +
            'DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET et ' +
            'DISCORD_REDIRECT_URI dans les variables Canner.'
        );
    }

    const state = crypto.randomBytes(24).toString('hex');

    req.session.discordOAuthState = state;

    req.session.save(error => {
        if (error) {
            console.error(
                'Erreur de session avant OAuth :',
                error
            );

            return res.status(500).send(
                'Impossible de démarrer la connexion Discord.'
            );
        }

        const params = new URLSearchParams({
            client_id: DISCORD_CLIENT_ID,
            redirect_uri: DISCORD_REDIRECT_URI,
            response_type: 'code',
            scope: 'identify',
            state
        });

        return res.redirect(
            `https://discord.com/oauth2/authorize?${params.toString()}`
        );
    });
});

// Retour de Discord après autorisation.
app.get('/auth/discord/callback', async (req, res) => {
    const { code, state, error } = req.query;

    if (error) {
        return res.status(400).send(
            'Connexion Discord annulée ou refusée. Retourne au site et réessaie.'
        );
    }

    if (
        !code ||
        !state ||
        !req.session.discordOAuthState ||
        state !== req.session.discordOAuthState
    ) {
        return res.status(400).send(
            'État OAuth invalide ou expiré. Retourne au site et réessaie.'
        );
    }

    delete req.session.discordOAuthState;

    try {
        // Échanger le code OAuth contre un jeton d'accès.
        const tokenResponse = await fetch(
            `${DISCORD_API}/oauth2/token`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: new URLSearchParams({
                    client_id: DISCORD_CLIENT_ID || '',
                    client_secret: DISCORD_CLIENT_SECRET || '',
                    grant_type: 'authorization_code',
                    code: String(code),
                    redirect_uri: DISCORD_REDIRECT_URI || ''
                })
            }
        );

        const tokenData = await tokenResponse.json();

        if (!tokenResponse.ok || !tokenData.access_token) {
            console.error(
                'Échange OAuth Discord refusé :',
                tokenData.error || tokenResponse.status
            );

            return res.status(502).send(
                'Discord a refusé la connexion. Vérifie les variables ' +
                'et l’URI de redirection.'
            );
        }

        // Récupérer le compte Discord connecté.
        const userResponse = await fetch(
            `${DISCORD_API}/users/@me`,
            {
                headers: {
                    Authorization: `Bearer ${tokenData.access_token}`
                }
            }
        );

        const user = await userResponse.json();

        if (!userResponse.ok || !user.id) {
            return res.status(502).send(
                'Impossible de récupérer le compte Discord. Réessaie.'
            );
        }

        // Ne conserver que les informations publiques nécessaires.
        req.session.discordUser = {
            id: String(user.id),
            username: String(
                user.global_name || user.username || 'Joueur RP'
            ),
            avatar: user.avatar
                ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`
                : null
        };

        req.session.save(saveError => {
            if (saveError) {
                console.error(
                    'Enregistrement de session impossible :',
                    saveError
                );

                return res.status(500).send(
                    'Connexion réussie, mais la session n’a pas pu être enregistrée. Réessaie.'
                );
            }

            return res.redirect('/');
        });
    } catch (err) {
        console.error('Erreur callback Discord :', err);

        return res.status(500).send(
            'Erreur pendant la connexion Discord. Consulte les journaux du serveur.'
        );
    }
});

// Déconnexion du site.
app.get('/auth/logout', (req, res) => {
    req.session.destroy(error => {
        if (error) {
            console.error('Erreur de déconnexion :', error);
        }

        res.clearCookie('blainville.sid');
        res.redirect('/');
    });
});

// Informations sur le compte actuellement connecté.
app.get('/api/me', (req, res) => {
    if (!req.session.discordUser) {
        return res.status(401).json({
            authenticated: false
        });
    }

    return res.json({
        authenticated: true,
        user: req.session.discordUser
    });
});

// Lire les données du téléphone du compte connecté.
app.get('/api/phone-data', requireDiscordLogin, (req, res) => {
    const allData = getAccountData();

    const userData =
        allData[req.session.discordUser.id] || {};

    return res.json({
        data: userData
    });
});

// Sauvegarder les données du téléphone du compte connecté.
app.put('/api/phone-data', requireDiscordLogin, (req, res) => {
    if (
        !req.body ||
        !req.body.data ||
        typeof req.body.data !== 'object' ||
        Array.isArray(req.body.data)
    ) {
        return res.status(400).json({
            error: 'Format des données invalide.'
        });
    }

    if (
        Buffer.byteLength(
            JSON.stringify(req.body.data),
            'utf8'
        ) > 200 * 1024
    ) {
        return res.status(413).json({
            error: 'Les données du téléphone sont trop volumineuses.'
        });
    }

    try {
        const allData = getAccountData();

        allData[req.session.discordUser.id] = req.body.data;

        saveAccountData(allData);

        return res.json({
            ok: true
        });
    } catch (error) {
        console.error(
            'Sauvegarde des données impossible :',
            error
        );

        return res.status(500).json({
            error: 'Impossible de sauvegarder les données du téléphone.'
        });
    }
});

// ======================================================
// SERVEUR HTTP ET WEBSOCKET
// ======================================================

const server = http.createServer(app);

const wss = new WebSocket.Server({
    server,
    maxPayload: 1024 * 1024
});

const discord = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers
    ]
});

// Numéro RP -> connexion WebSocket active.
const clientsByNumber = new Map();

// ID du groupe -> membres connectés.
const groupRooms = new Map();

function send(socket, payload) {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(payload));
    }
}

function validPhoneNumber(value) {
    return typeof value === 'string' &&
        /^555-\d{3}-\d{4}$/.test(value);
}

function validGroupId(value) {
    return typeof value === 'string' &&
        /^grp-[a-z0-9-]{1,80}$/i.test(value);
}

function safeName(value) {
    if (typeof value !== 'string') {
        return 'Joueur RP';
    }

    const name = value
        .trim()
        .replace(/[<>\u0000-\u001f]/g, '')
        .slice(0, 40);

    return name || 'Joueur RP';
}

function getGroupMembers(room) {
    return [...room.entries()].map(([number, member]) => ({
        number,
        name: member.name || number
    }));
}

function removeFromGroup(socket, groupId, notify = true) {
    const room = groupRooms.get(groupId);

    if (!room || !socket.phoneNumber) {
        return;
    }

    const current = room.get(socket.phoneNumber);

    if (!current || current.socket !== socket) {
        return;
    }

    room.delete(socket.phoneNumber);

    if (notify) {
        for (const member of room.values()) {
            send(member.socket, {
                type: 'group-peer-left',
                groupId,
                memberNumber: socket.phoneNumber,
                memberName: socket.phoneName
            });
        }
    }

    if (room.size === 0) {
        groupRooms.delete(groupId);
    }
}

// Vérification du serveur.
app.get('/health', (req, res) => {
    res.json({
        ok: true,
        service: 'Blainville RP QC'
    });
});

// Nombre de membres humains du serveur Discord.
app.get('/api/members', async (req, res) => {
    try {
        if (!process.env.GUILD_ID) {
            return res.status(500).json({
                error: 'GUILD_ID manquant dans les variables d’environnement.'
            });
        }

        const guild = discord.guilds.cache.get(
            process.env.GUILD_ID
        );

        if (!guild) {
            return res.status(404).json({
                error: 'Serveur Discord introuvable.'
            });
        }

        await guild.members.fetch();

        const count = guild.members.cache.filter(
            member => !member.user.bot
        ).size;

        return res.json({ count });
    } catch (error) {
        console.error('Erreur Discord API :', error);

        return res.status(500).json({
            error: 'Erreur récupération membres.'
        });
    }
});

// ======================================================
// GESTION DES APPELS
// ======================================================

wss.on('connection', socket => {
    socket.phoneNumber = null;
    socket.phoneName = 'Joueur RP';

    socket.on('message', raw => {
        let message;

        try {
            message = JSON.parse(raw.toString());
        } catch {
            send(socket, {
                type: 'server-error',
                message: 'Message invalide.'
            });
            return;
        }

        if (!message || typeof message.type !== 'string') {
            send(socket, {
                type: 'server-error',
                message: 'Format de message invalide.'
            });
            return;
        }

        // Enregistrer le téléphone.
        if (message.type === 'register') {
            if (!validPhoneNumber(message.number)) {
                send(socket, {
                    type: 'server-error',
                    message: 'Numéro RP invalide.'
                });

                socket.close(1008, 'Numéro invalide');
                return;
            }

            const previous = clientsByNumber.get(message.number);

            if (previous && previous !== socket) {
                for (const groupId of [...groupRooms.keys()]) {
                    removeFromGroup(previous, groupId);
                }

                send(previous, {
                    type: 'server-error',
                    message: 'Ce numéro est connecté ailleurs.'
                });

                previous.phoneNumber = null;
                previous.close(4001, 'Session remplacée');
            }

            socket.phoneNumber = message.number;
            socket.phoneName = safeName(message.name);

            clientsByNumber.set(
                socket.phoneNumber,
                socket
            );

            send(socket, {
                type: 'registered',
                number: socket.phoneNumber
            });

            console.log(
                `[Téléphone] ${socket.phoneName} connecté : ${socket.phoneNumber}`
            );

            return;
        }

        // Les autres actions nécessitent un téléphone enregistré.
        if (
            !socket.phoneNumber ||
            clientsByNumber.get(socket.phoneNumber) !== socket
        ) {
            send(socket, {
                type: 'server-error',
                message: 'Enregistre ton numéro avant d’appeler.'
            });
            return;
        }

        // Rejoindre un appel de groupe.
        if (message.type === 'group-join') {
            if (!validGroupId(message.groupId)) {
                send(socket, {
                    type: 'server-error',
                    message: 'Identifiant de groupe invalide.'
                });
                return;
            }

            const groupId = message.groupId;
            let room = groupRooms.get(groupId);

            if (!room) {
                room = new Map();
                groupRooms.set(groupId, room);
            }

            room.set(socket.phoneNumber, {
                socket,
                name: socket.phoneName
            });

            send(socket, {
                type: 'group-members',
                groupId,
                groupName: safeName(message.groupName),
                members: getGroupMembers(room)
            });

            for (const member of room.values()) {
                if (member.socket !== socket) {
                    send(member.socket, {
                        type: 'group-peer-joined',
                        groupId,
                        memberNumber: socket.phoneNumber,
                        memberName: socket.phoneName
                    });
                }
            }

            console.log(
                `[Téléphone] ${socket.phoneNumber} rejoint ${groupId}`
            );

            return;
        }

        // Quitter un appel de groupe.
        if (message.type === 'group-leave') {
            if (validGroupId(message.groupId)) {
                removeFromGroup(socket, message.groupId);
            }
            return;
        }

        // Inviter un joueur dans un appel de groupe.
        if (message.type === 'group-invite') {
            const target = typeof message.target === 'string'
                ? message.target
                : '';

            const groupId = message.groupId;

            if (
                !validPhoneNumber(target) ||
                target === socket.phoneNumber ||
                !validGroupId(groupId)
            ) {
                send(socket, {
                    type: 'call-error',
                    message: 'Numéro ou groupe invalide.',
                    target
                });
                return;
            }

            const room = groupRooms.get(groupId);

            if (!room || !room.has(socket.phoneNumber)) {
                send(socket, {
                    type: 'call-error',
                    message: 'Rejoins le groupe avant d’inviter des joueurs.',
                    target
                });
                return;
            }

            const recipient = clientsByNumber.get(target);

            if (!recipient || recipient.readyState !== WebSocket.OPEN) {
                send(socket, {
                    type: 'group-invite-reject',
                    from: target,
                    fromName: target,
                    target: socket.phoneNumber,
                    groupId,
                    reason: 'offline'
                });
                return;
            }

            send(recipient, {
                type: 'group-invite',
                from: socket.phoneNumber,
                fromName: socket.phoneName,
                target,
                groupId,
                groupName: safeName(message.groupName)
            });

            return;
        }

        // Refuser une invitation de groupe.
        if (message.type === 'group-invite-reject') {
            const target = typeof message.target === 'string'
                ? message.target
                : '';

            if (!validPhoneNumber(target)) {
                return;
            }

            const recipient = clientsByNumber.get(target);

            if (recipient) {
                send(recipient, {
                    type: 'group-invite-reject',
                    from: socket.phoneNumber,
                    fromName: socket.phoneName,
                    target,
                    groupId: validGroupId(message.groupId)
                        ? message.groupId
                        : '',
                    reason: message.reason === 'busy'
                        ? 'busy'
                        : 'rejected'
                });
            }

            return;
        }

        // Signalisation WebRTC pour les appels.
        const allowedTypes = new Set([
            'call-offer',
            'call-answer',
            'call-candidate',
            'call-reject',
            'call-end'
        ]);

        if (!allowedTypes.has(message.type)) {
            send(socket, {
                type: 'server-error',
                message: 'Type de message non autorisé.'
            });
            return;
        }

        const target = typeof message.target === 'string'
            ? message.target
            : '';

        if (
            !validPhoneNumber(target) ||
            target === socket.phoneNumber
        ) {
            send(socket, {
                type: 'call-error',
                message: 'Numéro de destination invalide.',
                target
            });
            return;
        }

        const groupId = message.groupId || '';

        if (groupId) {
            const room = validGroupId(groupId)
                ? groupRooms.get(groupId)
                : null;

            if (
                !room ||
                !room.has(socket.phoneNumber) ||
                !room.has(target)
            ) {
                send(socket, {
                    type: 'call-error',
                    message: 'Les deux joueurs doivent être dans le même groupe.',
                    target,
                    groupId
                });
                return;
            }
        }

        const recipient = clientsByNumber.get(target);

        if (!recipient || recipient.readyState !== WebSocket.OPEN) {
            if (message.type === 'call-offer') {
                send(socket, {
                    type: 'call-error',
                    message: 'Ce numéro est hors ligne ou indisponible.',
                    target,
                    groupId
                });
            }
            return;
        }

        const forwarded = {
            type: message.type,
            from: socket.phoneNumber,
            fromName: socket.phoneName,
            target
        };

        if (groupId) {
            forwarded.groupId = groupId;
        }

        if (message.type === 'call-offer') {
            forwarded.offer = message.offer;
        }

        if (message.type === 'call-answer') {
            forwarded.answer = message.answer;
        }

        if (message.type === 'call-candidate') {
            forwarded.candidate = message.candidate;
        }

        if (message.type === 'call-reject') {
            forwarded.reason = message.reason === 'busy'
                ? 'busy'
                : 'rejected';
        }

        send(recipient, forwarded);
    });

    socket.on('close', () => {
        if (
            socket.phoneNumber &&
            clientsByNumber.get(socket.phoneNumber) === socket
        ) {
            clientsByNumber.delete(socket.phoneNumber);

            for (const groupId of [...groupRooms.keys()]) {
                removeFromGroup(socket, groupId);
            }

            console.log(
                `[Téléphone] ${socket.phoneNumber} déconnecté`
            );
        }
    });

    socket.on('error', error => {
        console.error(
            'Erreur WebSocket téléphone :',
            error.message
        );
    });
});

// ======================================================
// DÉMARRAGE
// ======================================================

discord.once('ready', () => {
    console.log(`Bot Discord connecté : ${discord.user.tag}`);
});

discord.on('error', error => {
    console.error('Erreur Discord :', error);
});

const PORT = Number(process.env.PORT || 3000);

const httpServer = server.listen(PORT, () => {
    console.log(`Blainville RP QC écoute sur le port ${PORT}`);
    console.log('Connexion Discord : /auth/discord');
    console.log('API compte : /api/me');
    console.log('API téléphone : /api/phone-data');
    console.log('API membres : /api/members');
    console.log('Vérification serveur : /health');
});

if (!process.env.DISCORD_TOKEN) {
    console.warn(
        'DISCORD_TOKEN absent : le bot Discord ne sera pas connecté. ' +
        'La connexion OAuth peut tout de même fonctionner.'
    );
} else {
    discord.login(process.env.DISCORD_TOKEN).catch(error => {
        console.error(
            'Connexion du bot Discord impossible :',
            error
        );
    });
}

// Arrêt propre.
let shuttingDown = false;

function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log('Arrêt du serveur...');

    for (const socket of wss.clients) {
        socket.close(1001, 'Serveur arrêté');
    }

    wss.close();
    discord.destroy();

    httpServer.close(() => process.exit(0));

    setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
