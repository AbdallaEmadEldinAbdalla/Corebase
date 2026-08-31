/**
 * services/worker — the one separate process from day one (D-020).
 * T5 fills in the BullMQ consumers and the provisioning saga; this is the
 * process shell so the deploy unit and the workspace graph exist from T1.
 */
console.log(JSON.stringify({ level: 'info', msg: 'worker starting', service: 'worker' }));
