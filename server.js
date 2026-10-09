
/**
 * Blainville RP QC — site, API Discord et appels audio de groupe.
 * Node.js 18+
 * Démarrage : npm start
 *
 * Variables d'environnement :
 * DISCORD_TOKEN, GUILD_ID et PORT (fourni par Canner).
 */

'use strict';

require('dotenv').config();

const path = require('path');
const http = require('http');
const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const { Client, GatewayIntentBits } = require('discord.js');

const app = express();

app.use(cors());
app.use(express.json({ limit: '32kb' }));
app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'roleplay.html'));
});

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

// Numéro RP -> connexion active.
const clientsByNumber = new Map();

// ID du groupe -> membres connectés.
const groupRooms = new Map();

function send(socket, payload) {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(payload));
    }
}

function validPhoneNumber(value) {
    return typeof value === 'string'
        && /^555-\d{3}-\d{4}$/.test(value);
}

function validGroupId(value) {
    return typeof value === 'string'
        && /^grp-[a-z0-9-]{1,80}$/i.test(value);
}

function safeName(value) {
    if (typeof value !== 'string') return 'Joueur RP';

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

    if (!room || !socket.phoneNumber) return;

    const current = room.get(socket.phoneNumber);

    // Ne pas supprimer une nouvelle session du même numéro.
    if (!current || current.socket !== socket) return;

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

// API Discord : nombre de membres humains.
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

        const count = guild.members.cache
            .filter(member => !member.user.bot)
            .size;

        return res.json({ count });

    } catch (error) {
        console.error('Erreur Discord API :', error);

        return res.status(500).json({
            error: 'Erreur récupération membres.'
        });
    }
});

// WebSocket : appels individuels et de groupe.
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
                // Retirer l'ancienne session de ses groupes.
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

        // Tous les messages suivants exigent un téléphone enregistré.
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

        // Rejoindre une salle d'appel de groupe.
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

            const existingMembers = getGroupMembers(room)
                .filter(member => member.number !== socket.phoneNumber);

            room.set(socket.phoneNumber, {
                socket,
                name: socket.phoneName
            });

            // Envoyer la liste des participants au nouveau membre.
            send(socket, {
                type: 'group-members',
                groupId,
                groupName: safeName(message.groupName),
                members: getGroupMembers(room)
            });

            // Informer les autres membres de son arrivée.
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
                `[Téléphone] ${socket.phoneNumber} rejoint ${groupId} (${existingMembers.length + 1} membre(s))`
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

        // Inviter un contact dans un appel de groupe.
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

        // Refus d'une invitation à un groupe.
        if (message.type === 'group-invite-reject') {
            const target = typeof message.target === 'string'
                ? message.target
                : '';

            if (!validPhoneNumber(target)) return;

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

        // Messages de signalisation WebRTC.
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

        // En groupe, les deux participants doivent avoir rejoint la salle.
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

        if (groupId) forwarded.groupId = groupId;

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

// Bot Discord.
discord.once('ready', () => {
    console.log(`Bot Discord connecté : ${discord.user.tag}`);
});

discord.on('error', error => {
    console.error('Erreur Discord :', error);
});

// Démarrage du serveur sur le port fourni par Canner.
const PORT = Number(process.env.PORT || 3000);

const httpServer = server.listen(PORT, () => {
    console.log(`Blainville RP QC écoute sur le port ${PORT}`);
    console.log('API membres : /api/members');
    console.log('Vérification serveur : /health');
});

// Connexion du bot Discord.
if (!process.env.DISCORD_TOKEN) {
    console.error(
        'DISCORD_TOKEN manquant dans les variables d’environnement.'
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
