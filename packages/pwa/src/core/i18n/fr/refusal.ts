import type { Messages } from '../en';

export const refusal: Messages['refusal'] = {
  newCode: (machine) => `lancez \`perch pair\` sur ${machine} pour en obtenir un nouveau`,
  badToken: (machine) => `${machine} a refusé le jeton — vérifiez le jeton de cette entrée`,
  codeExpired: (newCode) => `Ce code d’association a expiré — ${newCode}`,
  codeUsed: (newCode) => `Ce code d’association a déjà servi — ${newCode}`,
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
  busy: (machine) => `${machine} est saturée : trop de téléphones s’y connectent`,
  other: (machine, detail) => `${machine} a refusé ce téléphone (${detail})`,
  code: (code) => `code ${code}`,
};
