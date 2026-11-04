import type { Messages } from '../en';

export const status: Messages['status'] = {
  labels: {
    'needs-feedback': 'Vous attend',
    'needs-hands': 'À faire à la main',
    idle: 'Inactif',
    finished: 'Terminé',
    review: 'À relire',
    blocked: 'Bloqué',
    parked: 'En veille',
    working: 'En cours',
  },
  needsOrchestrator: 'Attend l’orchestrateur',
  pill: (label) => `Statut : ${label}`,
  closeMenu: 'Fermer le menu des statuts',
  setStatus: 'Choisir le statut',
  connection: {
    online: 'En ligne',
    connecting: 'Connexion…',
    offline: 'Hors ligne',
    off: 'Désactivée',
  },
  secondsAgo: (n) => `il y a ${n} s`,
  minutesAgo: (n) => `il y a ${n} min`,
  hoursAgo: (n) => `il y a ${n} h`,
  errorCode: (code) => ` (code ${code})`,
  age: {
    underMinute: '<1 min',
    minutes: (n) => `${n} min`,
    hours: (n) => `${n} h`,
    days: (n) => `${n} j`,
  },
};
