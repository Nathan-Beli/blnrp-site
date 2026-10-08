
/**
 * Blainville RP QC
 * Site web + API Discord + signalisation du téléphone
 *
 * Installation :
 * npm install express cors discord.js dotenv ws
 *
 * Démarrage :
 * node server.js
 */

'use strict';

require('dotenv').config();

const { Client, GatewayIntentBits } = require('discord.js');
const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const app = express();

app.use(cors());
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname)));

const server = http.createServer(app);

const wss = new WebSocket.Server({
    server,
    maxPayload: 1024 * 1024
});

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers
    ]
});

const clientsByNumber = new Map();

function send(socket, message) {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(message));
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

// ================================================
// API DISCORD : nombre de membres humains
// ================================================

app.get('/api/members', async (req, res) => {
    try {
        if (!process.env.GUILD_ID) {
            return res.status(500).json({
                error: 'GUILD_ID manquant dans le fichier .env'
            });
        }

        const guild = client.guilds.cache.get(
            process.env.GUILD_ID
        );

        if (!guild) {
            return res.status(404).json({
                error: 'Serveur Discord introuvable'
            });
        }

        await guild.members.fetch();

        const humanCount = guild.members.cache
            .filter(member => !member.user.bot)
            .size;

        return res.json({
            count: humanCount
        });

    } catch (error) {
        console.error('Erreur Discord API :', error);

        return res.status(500).json({
            error: 'Erreur récupération membres'
        });
    }
});

// ================================================
// TÉLÉPHONE : signalisation des appels WebRTC
// ================================================

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

        // Enregistrer le téléphone du joueur
        if (message.type === 'register') {
            if (!validPhoneNumber(message.number)) {
                send(socket, {
                    type: 'server-error',
                    message: 'Numéro RP invalide.'
                });

                socket.close(1008, 'Numéro invalide');
                return;
            }

            // Une connexion active par numéro
            const previous = clientsByNumber.get(message.number);

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

        // Vérifier que le joueur est enregistré
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

        const allowedMessages = new Set([
            'call-offer',
            'call-answer',
            'call-candidate',
            'call-reject',
            'call-end'
        ]);

        if (!allowedMessages.has(message.type)) {
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

        // Relayer les informations de signalisation WebRTC
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

// ================================================
// CONNEXION DU BOT DISCORD
// ================================================

client.once('ready', () => {
    console.log(
        `Bot Discord connecté : ${client.user.tag}`
    );
});

client.on('error', error => {
    console.error('Erreur du bot Discord :', error);
});

// ================================================
// DÉMARRAGE
// ================================================

const PORT = Number(process.env.PORT || 3000);

server.listen(PORT, () => {
    console.log(
        `Serveur Blainville RP QC démarré sur le port ${PORT}`
    );

    console.log(`Site web : http://localhost:${PORT}`);
    console.log(`Téléphone : ws://localhost:${PORT}`);
});

if (!process.env.DISCORD_TOKEN) {
    console.error(
        'DISCORD_TOKEN manquant dans le fichier .env'
    );
} else {
    client.login(process.env.DISCORD_TOKEN).catch(error => {
        console.error(
            'Connexion Discord impossible :',
            error
        );
    });
}

function shutdown() {
    console.log('Arrêt du serveur...');

    for (const socket of wss.clients) {
        socket.close(1001, 'Serveur arrêté');
    }

    server.close(() => process.exit(0));
    client.destroy();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
