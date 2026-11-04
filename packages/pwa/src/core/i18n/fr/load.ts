import type { Messages } from '../en';

export const load: Messages['load'] = {
  cpu: 'CPU',
  ram: 'RAM',
  left: ' restante',
  beforeKill: (kill) => `· ${kill} avant arrêt forcé`,
  help: 'Que signifient ces chiffres ?',
  dismiss: 'Fermer',
  slowTitle: (slow) => `${slow} restante`,
  slowBody: (warn, alert) =>
    ` — ce qu’une nouvelle tâche peut prendre avant que cette machine ralentisse. Au-delà, elle doit déplacer de la mémoire sur le disque. Vert au-dessus de ${warn}, orange en dessous, rouge sous ${alert}.`,
  killTitle: (kill) => `${kill} avant arrêt forcé`,
  killBody:
    ' — ce qui peut être pris avant que le noyau arrête un processus pour libérer de la place. La machine est déjà lente bien avant.',
  cache:
    'Les fichiers que le noyau garde en cache comptent comme libres dans les deux chiffres : il les libère dès que la mémoire est nécessaire.',
  killsTitle: (n) => `${n} ${n <= 1 ? 'arrêté' : 'arrêtés'}`,
  killsBody:
    ' — processus arrêtés par le noyau depuis la connexion de cette app. Il choisit selon le score OOM, souvent un outil auxiliaire plutôt que votre session : on dirait alors que l’outillage se casse, pas qu’un espace de travail disparaît.',
  done: 'OK',
};
