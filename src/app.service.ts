import { Injectable } from '@nestjs/common';
import { Octokit } from '@octokit/rest';
import { DiscortBot } from './bot-config/bot-config';
import { InputData } from './model/input-data.model';

@Injectable()
export class AppService {
  async getHello() {
    const octoGit = new Octokit({
      auth: process.env.GITHUB_ACCESS_TOKEN
    });

    try {
      const clientObj: any = new DiscortBot();

      clientObj.on('message', async (msg: any) => {
        if (msg?.embeds[0]?.title?.includes('new commit')) {
          const url = msg?.embeds[0]?.description.split('\n').slice(-1).pop();
          const commit_sha = url.substring(url.indexOf('('), url.indexOf(')')).split('/').pop();

          const repoCommits = await octoGit.repos.getCommit({ "owner": 'vs8871', "repo": 'auth-repo', "ref": commit_sha });
          const data: InputData[] = [];
          for (let index = 0; index < repoCommits?.data?.files.length; index++) {
            const blob_sha = repoCommits?.data?.files[index].sha;

            const blobs = await octoGit.git.getBlob({ "file_sha": blob_sha, "owner": 'vs8871', "repo": 'auth-repo' });

            const fileContent = atob(blobs.data.content.replaceAll('\n', ''));

            let queries = fileContent.split(';');
            queries = queries.map(s => s.replaceAll('\n', ''));

            for (let index = 0; index < queries.length; index++) {
              const query = queries[index]?.toLocaleLowerCase();
              if (query?.startsWith('create table')) {
                const { entityStr, tableName } = this.createNewEntity(queries[index]);

                this.setEntityData(entityStr, tableName, data);
              }
              else if (query?.startsWith('alter table') && query?.includes('add column')) {
                const { tableName, columnName, columnType, entityColumnName, entityColumnType } =
                  this.getEntityDetails(query);

                const { pathOfFile, entityFileName, fileSha } =
                  await this.getExistingEntityDetails(octoGit, tableName);
                const entityBlob = await octoGit.git.getBlob({ "file_sha": fileSha, "owner": 'vs8871', "repo": 'entity-library' });
                const existingEntityContent = atob(entityBlob.data.content.replaceAll('\n', ''));

                const alterEntity = this.updateExistingEntity(existingEntityContent,
                  columnName, columnType, entityColumnName, entityColumnType);

                this.setEntityData(alterEntity, entityFileName, data, pathOfFile);
                // todo check for multiple query for same table
              }
              else if (query?.startsWith('alter table') && query?.includes('drop column')) {
                // to do for drop column
              }
              else if (query?.startsWith('alter table') && query?.includes('alter column') && query?.includes('type')) {
                // to do for changing the data type of column
              }
              else if (query?.startsWith('alter table') && query?.includes('rename column')) {
                // to do for renaming the column
              }
              else if (query?.startsWith('alter table') && query?.includes('rename') && !query?.includes('rename column')) {
                // to do for renaming the table
              }
              else if (query?.startsWith('drop table')) {
                // to do for dropping the table
              }
            }
          }

          await this.createNewCommit(octoGit, data);
        }
        if (msg.content == 'ping') {
          msg.reply('pong');
          msg.channel.send('pong');
        }
      });

    } catch (error) {
      console.log(error);
    }
  }

  private async createNewCommit(octoGit, data: InputData[]) {
    const libraryCommit = await octoGit.repos.getCommit({
      owner: 'vs8871', ref: 'master', 'repo': 'entity-library'
    });

    const tree = await octoGit.git.getTree({
      "owner": 'vs8871', "repo": 'entity-library',
      "tree_sha": libraryCommit?.data?.commit?.tree?.sha, "recursive": "1",
    });

    let createTreeResponse;
    createTreeResponse = await octoGit.git.createTree({
      "owner": 'vs8871',
      "repo": 'entity-library',
      tree: this.getFileContent(data, tree)
    });

    const commitResponse = await octoGit.git.createCommit({
      "owner": 'vs8871',
      "repo": 'entity-library',
      message: `updated by autobot`,
      tree: createTreeResponse.data.sha,
      parents: [libraryCommit?.data?.sha],
    });

    const branchName = `refs/heads/snippetbot/updated-snippet-${Date.now()}`;
    console.log(`creating new branch named ${branchName}`);

    await octoGit.git.createRef({
      "owner": 'vs8871',
      "repo": 'entity-library',
      ref: branchName,
      sha: commitResponse.data.sha,
    });

    const s = createTreeResponse;
  }

  private setEntityData(entityStr: any, tableName: string, data: InputData[], pathOfFile?: string) {
    const obj: InputData = {
      fileContent: entityStr,
      fileName: tableName.replaceAll('_', '-'),
      path: pathOfFile ? pathOfFile : `src/entity/${tableName.replaceAll('_', '-')}.entity.ts`
    };
    data.push(obj);
  }

  private getEntityDetails(query: string) {
    const queryItem = query.split(' ');
    const tableName = queryItem[2];
    const columnName = queryItem[5];
    const columnType = queryItem[6].substring(0, queryItem[6].indexOf('('));

    const entityColumnName = this.convertsnakeToCamel(columnName);
    const entityColumnType = this.getColumnType(columnType);

    return { tableName, columnName, columnType, entityColumnName, entityColumnType };
  }

  private async getExistingEntityDetails(octoGit: any, searchKey: string) {
    const files = await octoGit.search.code({
      "q": `${searchKey} user:vs8871 repo:vs8871/entity-library`,
      "mediaType": { format: 'text-match' }
    });
    const pathOfFile = files.data.items[0].path;
    const entityFileName = files.data.items[0].name;
    const fileSha = files.data.items[0].sha;
    return { pathOfFile, entityFileName, fileSha };
  }

  updateExistingEntity(existingEntityContent: string,
    columnName: string, columnType: string, entityColumnName: string, entityColumnType: string) {
    let entityToUpdate =
      existingEntityContent.trim().substring(0, existingEntityContent.trim().length - 1);

    const newColumnTemplate = this.getNewColumn();
    entityToUpdate += '\r\n\r\n' + newColumnTemplate;

    entityToUpdate = entityToUpdate.replaceAll('{column_type}', columnType)
      .replaceAll('{column_name}', columnName)
      .replaceAll('{ entity_property }', entityColumnName)
      .replaceAll('{ entity_Property_type }', entityColumnType);

    entityToUpdate += '\r\n' + '}';

    return entityToUpdate;
  }

  createNewEntity(query: string) {
    const columnStr = query.replaceAll('\n', '');
    const columnsString = columnStr.substring(columnStr.indexOf('(') + 1, columnStr.indexOf(')'));

    const columns = columnsString.split(',');
    let entityTemplate = this.getEntityTemplate();
    const tableName = columnStr.substring(0, (query.indexOf('('))).split(' ').pop();
    let entityClassName = this.convertsnakeToCamel(tableName);
    entityClassName = entityClassName.charAt(0).toUpperCase() + entityClassName.slice(1);
    let entityStr = entityTemplate;
    for (let index = 1; index < columns.length; index++) {
      const columnRow = columns[index].trim();
      const columnData = columnRow.split(' ');
      const entityColumnName = this.convertsnakeToCamel(columnData[0]);
      const entityColumnType = this.getColumnType(columnData[1]);
      const columnName = columnData[0];
      const columnType = columnData[1]?.toLowerCase();

      entityStr = entityStr.replaceAll('{column_type}', columnType)
        .replaceAll('{column_name}', columnName)
        .replaceAll('{ entity_property }', entityColumnName)
        .replaceAll('{ entity_Property_type }', entityColumnType)
        .replaceAll('{table_name}', tableName)
        .replaceAll('{ entity_class }', entityClassName);

      if (index != columns.length - 1) {
        const newColumnTemplate = this.getNewColumn();
        entityStr += '\r\n\r\n' + newColumnTemplate;
      } else {
        entityStr += '\r\n' + '}';
      }
    }
    return { entityStr, tableName };
  }
  private convertsnakeToCamel(str: any) {
    return str.toLowerCase().replace(/([-_][a-z])/g, group => group
      .toUpperCase()
      .replace('-', '')
      .replace('_', '')
    );
  }

  getNewColumn() {
    return `    @Column({ type: '{column_type}', name: '{column_name}' })
    { entity_property }: { entity_Property_type };`
  }

  getEntityTemplate() {
    var fs = require('fs');
    try {
      var data = fs.readFileSync('sample_entity.txt', 'utf8');
      console.log(data.toString());
      return data.toString();
    } catch (e) {
      console.log('Error:', e.stack);
    }
  }

  getColumnType(type: string) {
    let entityType;
    switch (type?.toLowerCase()) {
      case 'integer':
        entityType = 'number'
        break;
      case 'bigint':
        entityType = 'number'
        break;
      case 'text':
      case 'varchar':
      case 'character varying':
        entityType = 'string'
        break;
      case 'timestamp':
        entityType = 'date'
        break;
      case 'boolean':
        entityType = 'boolean'
        break;
      case 'date':
        entityType = 'date'
        break;
      default:
        break;
    }
    return entityType;
  }

  private getFileContent(data: InputData[], tree: any) {
    const input: any[] = [];
    for (let index = 0; index < data.length; index++) {
      const obj = {
        path: data[index].path,
        content: data[index].fileContent,
        mode: '100644',
        type: 'blob',
      }
      input.push(obj);
    }

    input.push(...tree.data.tree.filter(el => el.type !== 'tree' && !(input.map(m => m.path)).includes(el.path)));

    return input;
  }
}
