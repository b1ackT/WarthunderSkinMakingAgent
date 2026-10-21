// Fixed tank camouflage belongs to the camo_skin_tex slot. A direct albedo
// replacement needs black alpha or the stock scalable camouflage covers it.
// https://wiki.warthunder.com/cdk/creation_camo
export function exportPolicy(part, { builtin = false } = {}) {
  const legacyBuiltin = builtin && part.rule === 'replace_tex' && part.param === true && /^hstv_l_(body|turret|gun|mg)_c$/.test(part.from);
  const rule = legacyBuiltin ? 'set_tex' : (part.rule || 'set_tex');
  if (!['set_tex', 'replace_tex'].includes(rule)) throw Error('未知游戏贴图规则');
  return { rule, param: rule === 'set_tex', alphaOverride: rule === 'replace_tex' && /_c$/.test(part.from) ? 0 : undefined };
}

export function skinConfig(parts, options = {}) {
  return 'name:t="user"\n\n' + parts.map(p => {
    const policy = exportPolicy(p, options);
    if (!/^[a-zA-Z0-9_.-]+$/.test(p.output) || !p.from || /["\r\n*]/.test(p.from)) throw Error('导出纹理名无效');
    return `${policy.rule}{\n  from:t="${p.from}*"\n  to:t="${p.output}.dds"\n${policy.param ? '  param:t="camo_skin_tex"\n' : ''}}\n\n`;
  }).join('');
}
