
/**
 * Blainville RP QC — serveur du site, API Discord et téléphone audio.
 * Node.js 18+
 * Démarrage Canner : npm start
 * Variables : DISCORD_TOKEN, GUILD_ID et PORT (fourni par l'hébergeur).
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

// Servir les fichiers du site.
app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'roleplay.html'));
});

// HTTP et WebSocket partagent le même serveur.
const server = http.createServer(app);
const wss = new WebSocket.Server({
    server,
    maxPayload: 1024 * 1024
});

// Bot Discord.
const discord = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers
    ]
});

// Numéro RP -> connexion WebSocket active.
const clientsByNumber = new Map();

function send(socket, payload) {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(payload));
    }
}

function validPhoneNumber(value) {
    return typeof value === 'string'
        && /^555-\d{3}-\d{4}$/.test(value);
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

// Vérifier que le serveur est en ligne.
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

// Téléphone : signalisation des appels audio WebRTC.
// Le serveur relaie les offres, réponses et candidats ICE.
// Le son circule généralement directement entre les navigateurs.
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

            // Fermer une éventuelle ancienne connexion.
            if (previous && previous !== socket) {
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

        // Le téléphone doit être enregistré.
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

        const recipient = clientsByNumber.get(target);

        if (
            !recipient ||
            recipient.readyState !== WebSocket.OPEN
        ) {
            if (message.type === 'call-offer') {
                send(socket, {
                    type: 'call-error',
                    message: 'Ce numéro est hors ligne ou indisponible.',
                    target
                });
            }
            return;
        }

        // Transmettre uniquement les données de signalisation utiles.
        const forwarded = {
            type: message.type,
            from: socket.phoneNumber,
            fromName: socket.phoneName,
            target
        };

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
            forwarded.reason =
                message.reason === 'busy' ? 'busy' : 'rejected';
        }

        send(recipient, forwarded);
    });

    socket.on('close', () => {
        // Ne pas supprimer une nouvelle connexion portant le même numéro.
        if (
            socket.phoneNumber &&
            clientsByNumber.get(socket.phoneNumber) === socket
        ) {
            clientsByNumber.delete(socket.phoneNumber);

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

// Événements Discord.
discord.once('ready', () => {
    console.log(`Bot Discord connecté : ${discord.user.tag}`);
});

discord.on('error', error => {
    console.error('Erreur Discord :', error);
});

// Démarrage sur le port fourni par Canner.
const PORT = Number(process.env.PORT || 3000);

server.listen(PORT, () => {
    console.log(`Blainville RP QC écoute sur le port ${PORT}`);
    console.log('API membres : /api/members');
    console.log('Vérification serveur : /health');
});

// Connexion du bot.
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

// Arrêt propre du serveur.
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

    server.close(() => process.exit(0));

    setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
