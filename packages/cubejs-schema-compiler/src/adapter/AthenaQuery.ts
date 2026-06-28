import { PrestodbQuery } from './PrestodbQuery';

export class AthenaQuery extends PrestodbQuery {
  public sqlTemplates() {
    const templates = super.sqlTemplates();
    // SQL function-template fix: Athena (Trino) native forms / unsupported deletes
    templates.functions.CHARACTERLENGTH = 'length({{ args[0] }})';
    delete templates.functions.OCTETLENGTH;
    delete templates.functions.COT;
    delete templates.functions.BITLENGTH;
    return templates;
  }
}
