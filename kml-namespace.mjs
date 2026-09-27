// Repair only a missing standard XML Schema Instance namespace declaration.
// Never rewrite the source file; its original bytes remain the audit identity.
export function prepareKmlXml(value) {
  const xml=String(value??'');
  const root=/<kml\b[^>]*>/i.exec(xml);
  if(!root||!/\bxsi:schemaLocation\s*=/.test(xml)||/\bxmlns:xsi\s*=/.test(root[0]))
    return {xml,repairNote:''};
  const fixedRoot=root[0].replace(/>$/,' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">');
  return {xml:xml.slice(0,root.index)+fixedRoot+xml.slice(root.index+root[0].length),
    repairNote:'Deklarasi xmlns:xsi yang tiada ditambah dalam memori untuk membaca KML; fail asal tidak diubah.'};
}
