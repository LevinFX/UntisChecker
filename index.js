require('dotenv').config();
const fs = require('fs');
const { WebUntis } = require('webuntis');
const { Client, LocalAuth } = require('whatsapp-web.js');
const cron = require('node-cron');
const qr_code = require('qrcode-terminal');

const UNTIS_SCHOOL = process.env.UNTIS_SCHOOL;
const UNTIS_USERNAME = process.env.UNTIS_USERNAME;
const UNTIS_PASSWORD = process.env.UNTIS_PASSWORD;
const UNTIS_URL = process.env.UNTIS_URL;
const WHATSAPP_GROUP_NAME = process.env.WHATSAPP_GROUP_NAME;

const untis = new WebUntis(UNTIS_SCHOOL, UNTIS_USERNAME, UNTIS_PASSWORD, UNTIS_URL);
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});
const TIMETABLE_FILE = 'timetable.json';


client.on('qr', qr => {
    console.log('Scanne diesen QR-Code in WhatsApp, um dich anzumelden:', qr);
    qr_code.generate(qr, {small: true});
});

client.on('ready', () => {
    console.log('WhatsApp-Client ist bereit!');
});

function formatDate(untisDate) {
    const dateString = untisDate.toString();
    const date = new Date(`${dateString.slice(0, 4)}-${dateString.slice(4, 6)}-${dateString.slice(6, 8)}`);
    return date.toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });
}


function formatTime(time) {
    const timeStr = time.toString().padStart(4, '0');
    return `${timeStr.slice(0, 2)}:${timeStr.slice(2, 4)}`;
}

async function fetchTimetable() {
    console.log("Fetching Timetable...");
    try {
        await untis.login();
        console.log("Erfolgreich bei WebUntis eingeloggt.");
        const today = new Date();
        const anfang = new Date();
        const nextWeek = new Date();
        nextWeek.setDate(today.getDate() + 14);
        anfang.setDate(today.getDate()-7);
        
        const classes = await untis.getOwnClassTimetableForRange(anfang, nextWeek);
        console.log("Rohdaten von WebUntis empfangen.");
        await untis.logout();
        
        return classes.filter(lesson => lesson.code === 'cancelled' || lesson.code === 'substitution' || lesson.te?.some(teacher => teacher.id === 0));
    } catch (error) {
        console.error('Fehler beim Abrufen des Stundenplans:', error);
        return null;
    }
}

function loadOldTimetable() {
    if (!fs.existsSync(TIMETABLE_FILE)) {
        console.log("Timetable file not found. Creating a new one.");
        fs.writeFileSync(TIMETABLE_FILE, JSON.stringify([]));
        return [];
    }
    return JSON.parse(fs.readFileSync(TIMETABLE_FILE));
}

function detectChanges(oldData, newData) {
    console.log("Detecting changes...");
    const changes = [];
    const oldMap = new Map(oldData.map(c => [c.id, c]));
    const newMap = new Map(newData.map(c => [c.id, c]));
    
    newData.forEach(newClass => {
        const subjectName = newClass.su?.[0]?.longname || 'Unbekanntes Fach';
        const dateFormatted = formatDate(newClass.date);
        const timeFormatted = formatTime(newClass.startTime);
        const type = newClass.code === 'cancelled' ? 'Ausfall' : newClass.code === 'substitution' ? 'Vertretung' : newClass.te?.some(teacher => teacher.id === 0) ? 'Ausfall (Kein Lehrer eingetragen)' : 'Unbekannt';
        const message = `- \`\`\`NEU: \`\`\`*${subjectName} ${type}*\`\`\` am \`\`\`*${dateFormatted}*\`\`\`, um \`\`\`*${timeFormatted}*.\n`;
        
        if (!oldMap.has(newClass.id)) {
            changes.push(message);
        }
    });
    
    oldData.forEach(oldClass => {
        if (!newMap.has(oldClass.id)) {
            const subjectName = oldClass.su?.[0]?.longname || 'Unbekanntes Fach';
            changes.push(`-\`\`\` ENTFERNT: ${subjectName} war am ${formatDate(oldClass.date)}, um ${formatTime(oldClass.startTime)} nicht mehr betroffen.\`\`\`\n`);
        }
    });
    
    console.log("Gefundene Änderungen:", changes);
    return changes;
}


function saveTimetable(newData) {
    console.log("Saving affected timetable entries...");
    const twoWeeksAgo = new Date();
    twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
    
    const filteredData = newData.filter(lesson => {
        const lessonDate = new Date(`${lesson.date.toString().slice(0, 4)}-${lesson.date.toString().slice(4, 6)}-${lesson.date.toString().slice(6, 8)}`);
        return lessonDate >= twoWeeksAgo;
    });
    
    fs.writeFileSync(TIMETABLE_FILE, JSON.stringify(filteredData, null, 2));
}

async function sendWhatsAppMessage(message) {
    console.log("Sending Message: " + message);
    const chats = await client.getChats();
    const group = chats.find(chat => chat.name === WHATSAPP_GROUP_NAME);
    if (group) {
        await group.sendMessage(message);
    } else {
        console.error('Gruppe nicht gefunden!');
    }
}

async function checkForChanges() {
    console.log("Checking For Changes...");
    const newTimetable = await fetchTimetable();
    if (!newTimetable) {
        console.log("Kein neuer Stundenplan gefunden.");
        return;
    }

    const oldTimetable = loadOldTimetable();
    const changes = detectChanges(oldTimetable, newTimetable);
    
    if (changes.length > 0) {
        saveTimetable(newTimetable);
        await sendWhatsAppMessage(`Stundenplan wurde geändert:\n\n${changes.join('\n')}`);
    } else {
        console.log("Keine Änderungen festgestellt.");
    }
}

client.on('disconnected', () => {
    console.error('WhatsApp-Client wurde getrennt. Starte neu...');
    client.initialize();
});
client.initialize();

cron.schedule('*/15 * * * * *', checkForChanges); // Läuft alle 15 Sekunden
