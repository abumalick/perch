import type { Messages } from '../en';

export const browser: Messages['browser'] = {
  start: 'Lancer le navigateur',
  browser: 'Navigateur',
  browserCount: (count: number) => `Navigateur (${count})`,
  closeMenu: 'Fermer le menu du navigateur',
  sessions: 'Sessions du navigateur',
  mainSession: 'principale',
  back: 'Retour',
  browserBack: 'Page précédente',
  browserForward: 'Page suivante',
  keyboard: 'Clavier',
  closeSession: 'Fermer la session',
  url: 'URL',
  go: 'Aller',
  connecting: 'Connexion…',
  retry: 'Réessayer',
  notFound: 'Session du navigateur introuvable.',
  openedElsewhere: 'Ouverte sur un autre appareil.',
  ended: 'Session du navigateur terminée.',
};
