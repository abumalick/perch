import type { Messages } from '../en';

const plural = (n: number, one: string, many: string) => (n <= 1 ? one : many);

export const home: Messages['home'] = {
  agentAddress: 'Adresse par laquelle les autres sessions Claude écrivent à celle-ci',
  urgent: 'Urgent',
  timeInStatus: 'Temps passé dans ce statut',
  forAge: (age) => `depuis ${age}`,
  testBuild: 'Version de test servie',
  new: 'Nouveau',
  settings: 'Réglages',
  sharedPreview: 'Aperçu partagé',
  sharedReady: '1 fichier prêt — ouvrez une session pour le joindre',
  noMachines: 'Aucune machine pour l’instant',
  noMachinesSub: 'Connectez une machine qui exécute l’agent Perch pour commencer.',
  addMachine: '⚙ Ajouter une machine',
  connecting: 'Connexion à vos machines…',
  reconnecting: 'Reconnexion…',
  cantConnect: 'Connexion impossible',
  cantReach: 'Vos machines sont injoignables',
  cantReachSub:
    'Vérifiez que ce téléphone est en ligne et que l’agent de chaque machine tourne et est connecté à son relais, puis reconnectez.',
  reconnect: 'Reconnecter',
  noWorkspaces: 'Aucun espace de travail pour l’instant',
  noWorkspacesSub: 'Lancez une session Claude sur l’une de vos machines.',
  createFirst: '＋ Créer votre premier espace de travail',
  hiddenByFilter: (n) => `${n} ${plural(n, 'session masquée', 'sessions masquées')} par votre filtre.`,
  showAll: 'Tout afficher',
  toggleChildren: (expanded, n) =>
    `${expanded ? 'Masquer' : 'Afficher'} ${n} ${plural(n, 'espace de travail enfant', 'espaces de travail enfants')}`,
  parked: (n) => `En veille · ${n}`,
  browserSessions: 'Sessions de navigateur',
  filter: {
    projects: (n) => `${n} projets`,
    all: 'Tous les projets',
    only: (subject) => `Seulement ${subject}`,
    hiding: (subject) => `Masqués : ${subject}`,
    modes: { only: 'Seulement', hide: 'Masquer' },
    label: 'Filtrer par projet',
    close: 'Fermer le filtre de projets',
    group: 'Projets',
    mode: 'Mode de filtre',
    clear: 'Effacer le filtre de projets',
  },
};
