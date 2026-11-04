import type { Messages } from '../en';

export const refusal: Messages['refusal'] = {
  newCode: (machine) => `lancez \`perch pair\` sur ${machine} pour en obtenir un nouveau`,
  badToken: (machine) => `${machine} a refusé le jeton — vérifiez le jeton de cette entrée`,
  codeExpired: (newCode) => `Ce code d’association a expiré — ${newCode}`,
  codeUsed: (newCode) => `Ce code d’association a déjà servi — ${newCode}`,
  proofInvalid: (newCode) => `Association refusée : le code n’est pas valable pour cette machine — ${newCode}`,
  enrolmentRefused: (newCode) =>
    `Association refusée : le code a expiré, a déjà servi ou n’est pas valable pour cette machine — ${newCode}`,
  wrongAgentKey: (machine) => `La clé de l’agent de cette entrée n’est pas celle de ${machine} — associez à nouveau cette machine`,
  revoked: (machine) => `Ce téléphone a été révoqué sur ${machine}`,
  tokenNotNeeded: (machine) =>
    `${machine} n’a plus besoin du jeton de cette entrée : la clé de l’appareil est inscrite — oubli du jeton et reconnexion`,
  enrolmentOff: (machine) => `L’inscription est désactivée sur ${machine} — associez plutôt avec \`perch pair\``,
  enrolmentClosed: (machine) =>
    `L’inscription est fermée sur ${machine} — lancez-y \`perch devices enrolment off\` pour autoriser l’association`,
  notEnrolled: (machine) => `Ce téléphone n’est pas inscrit sur ${machine} — lancez-y \`perch pair\` pour l’associer à nouveau`,
  agentSignature: (machine) =>
    `${machine} n’a pas pu vérifier la clé de l’appareil de ce téléphone — lancez-y \`perch pair\` pour un nouveau code`,
  relaySignature: 'Le relais a refusé ce téléphone : la signature de sa clé de l’appareil n’a pas été vérifiée',
  tooManyEnrolments: (machine) => `Trop de téléphones demandent à s’associer à ${machine} en ce moment — nouvel essai`,
  deviceKeyRequired: (machine) => `Le relais a refusé ce téléphone : ${machine} n’accepte que les téléphones dotés d’une clé de l’appareil`,
  challenge: 'Le relais a refusé ce téléphone : son défi de connexion avait expiré — nouvel essai',
  challengeUnanswered: 'Le relais n’a pas reçu la connexion de ce téléphone — nouvel essai',
  unknownAccount: (machine) => `Le relais ne connaît pas ${machine} — relancez-y \`perch connect\``,
  agentOffline: (machine) => `${machine} n’est pas connectée au relais`,
  agentSilent: (machine) => `${machine} n’a pas répondu via le relais`,
  busy: (machine) => `Le relais est saturé : trop de téléphones se connectent à ${machine}`,
  internal: 'Le relais a échoué (erreur interne) — nouvel essai',
  other: (detail) => `Le relais a refusé ce téléphone (${detail})`,
  code: (code) => `code ${code}`,
};
