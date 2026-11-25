'use strict';

function normalized(name) { return String(name || '').normalize('NFKC').trim(); }

function speakerResolver(ownerNames, contactNames) {
  const owners = new Set(['我', ...ownerNames].map(normalized).filter(Boolean));
  const contacts = new Set(contactNames.map(normalized).filter(Boolean));
  return message => {
    if (typeof message.isOwner === 'boolean' || message.isOwner === null) return message.isOwner;
    if (message.is_owner === 1) return true;
    if (message.is_owner === 0) return false;
    const sender = normalized(message.sender || message.name || message.senderName);
    if (!sender || sender === '未标注') return null;
    const matchesOwner = owners.has(sender);
    const matchesContact = contacts.has(sender);
    return matchesOwner === matchesContact ? null : matchesOwner;
  };
}

function speakerLabel(isOwner) {
  if (isOwner === true) return '用户本人';
  if (isOwner === false) return '联系人';
  return '身份未确认';
}

module.exports = { speakerResolver, speakerLabel };
