import { Injectable } from '@nestjs/common';
import { Octokit } from '@octokit/rest';
import { DiscortBot } from './bot-config/bot-config';
import { InputData } from './model/input-data.model';

@Injectable()
export class AppService {
  async getHello() {
    const octoGit = new Octokit({
      auth: process.env.GITHUB_ACCESS_TOKEN,
    });

    try {
      const clientObj: any = new DiscortBot();

      clientObj.on('message', async (msg: any) => {
        if (msg?.embeds[0]?.title?.includes('new commit')) {
          const commit_sha = this.getCommitSha(msg);

          const repoCommits = await octoGit.repos.getCommit({
            owner: 'vs8871',
            repo: 'auth-repo',
            ref: commit_sha,
          });
          let data: InputData[] = [];
          for (let index = 0; index < repoCommits?.data?.files.length; index++) {
            const blobs = await this.getInputFileBlob(repoCommits, index, octoGit);

            // convert base 64 to string
            const fileContent = atob(blobs.data.content.replaceAll('\n', ''));
            const queries = fileContent.split(';')
              ?.map((s) => s.replaceAll('\n', ''))
              ?.map((s) => s.replaceAll('\r', ''));

            // to do fix empty array issue
            // fix .includes issue for all cases
            for (let index = 0; index < queries.length; index++) {
              const query = queries[index]?.toLocaleLowerCase()?.replace(/\s{2,}/g, ' ')?.trim();

              if (query?.startsWith('create table')) {
                this.setCreateTableData(queries, index, data);
              }
              else if (query?.startsWith('alter table') && query?.includes('add column')) {
                await this.setAddColumnData(query, data, octoGit);
              }
              else if (query?.startsWith('alter table') && query?.includes('drop column')) {
                await this.setDropColumnData(query, data, octoGit);
              }
              else if (query?.startsWith('alter table') && query?.includes('alter column') && query?.includes('type')) {
                await this.setColumnDataTypeChangeData(query, data, octoGit);
              }
              else if (query?.startsWith('alter table') && query?.includes('rename column')) {
                await this.setRenameColumnData(query, data, octoGit);
              }
              else if (query?.startsWith('alter table') && query?.includes('rename') && !query?.includes('rename column')) {
                await this.setTableRenameData(query, octoGit, data);
              }
              else if (query?.startsWith('drop table')) {
                await this.setDropTableData(query, octoGit, data);
              }
            }
          }
          if (data?.length > 0) {
            await this.createNewCommit(octoGit, data);
          }
        }
        // if (msg.content == 'ping') {
        //   msg.reply('pong');
        //   msg.channel.send('pong');
        // }
      });
    } catch (error) {
      console.log(error);
    }
  }

  private async getInputFileBlob(repoCommits, index: number, octoGit) {
    const blob_sha = repoCommits?.data?.files[index].sha;
    const blobs = await octoGit.git.getBlob({
      file_sha: blob_sha,
      owner: 'vs8871',
      repo: 'auth-repo',
    });
    return blobs;
  }

  private getCommitSha(msg: any) {
    const url = msg?.embeds[0]?.description.split('\n').slice(-1).pop();
    const commit_sha = url.substring(url.indexOf('('), url.indexOf(')')).split('/').pop();
    return commit_sha;
  }

  private async setDropTableData(query: string, octoGit, data: InputData[]) {
    const tableNames = this.getTableNameForDrop(query);

    for (let index = 0; index < tableNames?.length; index++) {
      const { pathOfFile } = await this.getExistingEntityDetails(
        octoGit,
        tableNames[index],
      );
      this.setEntityData(null, tableNames[index], data, pathOfFile);
    }
  }

  private async setTableRenameData(query: string, octoGit, data: InputData[]) {
    const {
      oldTableName,
      newTableName,
      oldEntityTableName,
      newEntityTableName,
    } = this.getEntityDetailsForRenameTable(query);

    const { pathOfFile, entityFileName, fileSha } =
      await this.getExistingEntityDetails(octoGit, oldTableName);
    const entityBlob = await octoGit.git.getBlob({
      file_sha: fileSha,
      owner: 'vs8871',
      repo: 'entity-library',
    });
    const existingEntityContent = atob(
      entityBlob.data.content.replaceAll('\n', ''),
    );

    const alterEntity = this.updateExistingEntityForTableRename(
      existingEntityContent,
      oldTableName,
      newTableName,
      oldEntityTableName,
      newEntityTableName,
    );

    this.setEntityData(alterEntity, entityFileName, data, pathOfFile);
  }

  private async setRenameColumnData(query: string, data: InputData[], octoGit) {
    const {
      tableName,
      oldColumnName,
      newColumnName,
      newEntityColumnName,
      oldEntityColumnName,
    } = this.getEntityDetailsForRenameColumn(query);
    if (data.some((t) => t.fileName.includes(tableName.replaceAll('_', '-')))) {
      const alreadyPresentEntity = data.find((m) =>
        m.fileName.includes(tableName.replaceAll('_', '-')),
      );
      const alterEntity = this.updateExistingEntityForColumnRename(
        alreadyPresentEntity.fileContent,
        oldColumnName,
        newColumnName,
        newEntityColumnName,
        oldEntityColumnName,
      );

      data = data.filter(
        (k) => !k.fileName.includes(tableName.replaceAll('_', '-')),
      );
      this.setEntityData(
        alterEntity,
        alreadyPresentEntity.fileName,
        data,
        alreadyPresentEntity.path,
      );
    } else {
      const { pathOfFile, entityFileName, fileSha } =
        await this.getExistingEntityDetails(octoGit, tableName);
      const entityBlob = await octoGit.git.getBlob({
        file_sha: fileSha,
        owner: 'vs8871',
        repo: 'entity-library',
      });
      const existingEntityContent = atob(
        entityBlob.data.content.replaceAll('\n', ''),
      );

      const alterEntity = this.updateExistingEntityForColumnRename(
        existingEntityContent,
        oldColumnName,
        newColumnName,
        newEntityColumnName,
        oldEntityColumnName,
      );

      this.setEntityData(alterEntity, entityFileName, data, pathOfFile);
    }
  }

  private async setColumnDataTypeChangeData(
    query: string,
    data: InputData[],
    octoGit,
  ) {
    const { tableName, entityValues } =
      this.getEntityDetailsForTypeChange(query);

    for (let index = 0; index < entityValues.length; index++) {
      if (
        data.some((t) => t.fileName.includes(tableName.replaceAll('_', '-')))
      ) {
        const alreadyPresentEntity = data.find((m) =>
          m.fileName.includes(tableName.replaceAll('_', '-')),
        );
        const alterEntity = this.updateExistingEntityFortypeChange(
          alreadyPresentEntity.fileContent,
          entityValues[index],
        );

        data = data.filter(
          (k) => !k.fileName.includes(tableName.replaceAll('_', '-')),
        );
        this.setEntityData(
          alterEntity,
          alreadyPresentEntity.fileName,
          data,
          alreadyPresentEntity.path,
        );
      } else {
        const { pathOfFile, entityFileName, fileSha } =
          await this.getExistingEntityDetails(octoGit, tableName);
        const entityBlob = await octoGit.git.getBlob({
          file_sha: fileSha,
          owner: 'vs8871',
          repo: 'entity-library',
        });
        const existingEntityContent = atob(
          entityBlob.data.content.replaceAll('\n', ''),
        );

        const alterEntity = this.updateExistingEntityFortypeChange(
          existingEntityContent,
          entityValues[index],
        );

        this.setEntityData(alterEntity, entityFileName, data, pathOfFile);
      }
    }
  }

  private async setDropColumnData(query: string, data: InputData[], octoGit) {
    const { tableName, entityValues } = this.getEntityDetailsForDrop(query);
    for (let index = 0; index < entityValues.length; index++) {
      if (
        data.some((t) => t.fileName.includes(tableName.replaceAll('_', '-')))
      ) {
        const alreadyPresentEntity = data.find((m) =>
          m.fileName.includes(tableName.replaceAll('_', '-')),
        );
        const alterEntity = this.updateExistingEntityForDrop(
          alreadyPresentEntity.fileContent,
          entityValues[index].columnName,
        );

        data = data.filter(
          (k) => !k.fileName.includes(tableName.replaceAll('_', '-')),
        );
        this.setEntityData(
          alterEntity,
          alreadyPresentEntity.fileName,
          data,
          alreadyPresentEntity.path,
        );
      } else {
        const { pathOfFile, entityFileName, fileSha } =
          await this.getExistingEntityDetails(octoGit, tableName);
        const entityBlob = await octoGit.git.getBlob({
          file_sha: fileSha,
          owner: 'vs8871',
          repo: 'entity-library',
        });
        const existingEntityContent = atob(
          entityBlob.data.content.replaceAll('\n', ''),
        );

        const alterEntity = this.updateExistingEntityForDrop(
          existingEntityContent,
          entityValues[index].columnName,
        );

        this.setEntityData(alterEntity, entityFileName, data, pathOfFile);
      }
    }
  }

  private async setAddColumnData(query: string, data: InputData[], octoGit) {
    const { tableName, entityValues } =
      this.getEntityDetailsForAddColumn(query);

    for (let index = 0; index < entityValues?.length; index++) {
      if (
        data.some((t) => t.fileName.includes(tableName.replaceAll('_', '-')))
      ) {
        const alreadyPresentEntity = data.find((m) =>
          m.fileName.includes(tableName.replaceAll('_', '-')),
        );
        const alterEntity = this.updateExistingEntity(
          alreadyPresentEntity.fileContent,
          entityValues[index].columnName,
          entityValues[index].columnType,
          entityValues[index].entityColumnName,
          entityValues[index].entityColumnType,
        );

        data = data.filter(
          (k) => !k.fileName.includes(tableName.replaceAll('_', '-')),
        );
        this.setEntityData(
          alterEntity,
          alreadyPresentEntity.fileName,
          data,
          alreadyPresentEntity.path,
        );
      } else {
        const { pathOfFile, entityFileName, fileSha } =
          await this.getExistingEntityDetails(octoGit, tableName);
        const entityBlob = await octoGit.git.getBlob({
          file_sha: fileSha,
          owner: 'vs8871',
          repo: 'entity-library',
        });
        const existingEntityContent = atob(
          entityBlob.data.content.replaceAll('\n', ''),
        );

        const alterEntity = this.updateExistingEntity(
          existingEntityContent,
          entityValues[index].columnName,
          entityValues[index].columnType,
          entityValues[index].entityColumnName,
          entityValues[index].entityColumnType,
        );

        this.setEntityData(alterEntity, entityFileName, data, pathOfFile);
      }
    }
  }

  private setCreateTableData(queries: string[], index: number, data: InputData[]) {
    const { entityStr, tableName } = this.createNewEntity(queries[index]);

    this.setEntityData(entityStr, tableName, data);
  }

  getTableNameForDrop(query: string) {
    const qFragment = query?.trim()?.replaceAll('\n', '')?.replaceAll('\r', '');
    const tableNames: string[] = [];
    if (qFragment.includes(',')) {
      const tablesQuery = qFragment.split(',');
      for (let index = 0; index < tablesQuery?.length; index++) {
        const qPart = tablesQuery[index]
          ?.trim()
          ?.replaceAll('\n', '')
          ?.replaceAll('\r', '');
        if (qPart?.toLowerCase()?.includes('drop')) {
          const tableName = qPart.split(' ')?.filter((y) => y.trim() != '')[2];
          tableNames.push(tableName);
        } else {
          tableNames.push(qPart);
        }
      }
    } else {
      const tableName = qFragment.split(' ')?.filter((y) => y.trim() != '')[2];
      tableNames.push(tableName);
    }
    return tableNames;
  }

  updateExistingEntityForTableRename(
    existingEntityContent: string,
    oldTableName: string,
    newTableName: string,
    oldEntityTableName: string,
    newEntityTableName: string,
  ) {
    const entityFrag = existingEntityContent.trim().split(';');

    const index = entityFrag.findIndex(
      (i) => i.includes(oldTableName) && i.includes('@Entity'),
    );
    const column = entityFrag.find(
      (i) => i.includes(oldTableName) && i.includes('@Entity'),
    );
    if (~index) {
      const columnFrag = column.split('\n');
      for (let index = 0; index < columnFrag?.length; index++) {
        if (
          columnFrag[index].includes(oldTableName) &&
          columnFrag[index].includes('@Entity')
        ) {
          columnFrag[index] = this.replaceValue(
            columnFrag[index],
            oldTableName,
            newTableName,
          );
        }
        if (
          columnFrag[index].includes(oldEntityTableName) &&
          columnFrag[index].includes('class')
        ) {
          columnFrag[index] = this.replaceValue(
            columnFrag[index],
            oldEntityTableName,
            newEntityTableName,
          );
        }
      }

      const newColumn = columnFrag.join('\n');

      entityFrag[index] = newColumn;
    }
    const updatedEntity = entityFrag.join(';');
    return updatedEntity;
  }
  getEntityDetailsForRenameTable(query: string) {
    let fragmentQ = query
      ?.replaceAll('\n', '')
      .replaceAll('\r', '')
      .split(' ')
      ?.filter((y) => y.trim() != '');
    const oldTableName = fragmentQ[2];
    const newTableName = fragmentQ[5];

    let oldEntityTableName = this.convertsnakeToCamel(oldTableName);
    oldEntityTableName =
      oldEntityTableName.charAt(0).toUpperCase() + oldEntityTableName.slice(1);

    let newEntityTableName = this.convertsnakeToCamel(newTableName);
    newEntityTableName =
      newEntityTableName.charAt(0).toUpperCase() + newEntityTableName.slice(1);

    return {
      oldTableName,
      newTableName,
      oldEntityTableName,
      newEntityTableName,
    };
  }
  getEntityDetailsForTypeChange(query: string) {
    const entityValues: any[] = [];
    const tableName = query?.trim()?.split(' ')[2];
    if (query.includes(',')) {
      const queries = query?.trim()?.split(',');
      for (let index = 0; index < queries?.length; index++) {
        if (queries[index]?.toLowerCase()?.includes('alter table')) {
          const columnName = queries[index]
            ?.trim()
            ?.split(' ')
            ?.filter((y) => y.trim() != '')[5];
          const columnType = queries[index]
            ?.trim()
            ?.split(' ')
            ?.filter((y) => y.trim() != '')[7]
            ?.includes('(')
            ? queries[index]
              ?.trim()
              ?.split(' ')
              ?.filter((y) => y.trim() != '')[7]
              ?.substring(
                0,
                queries[index]
                  ?.trim()
                  ?.split(' ')
                  ?.filter((y) => y.trim() != '')[7]
                  .indexOf('('),
              )
            : queries[index]
              ?.trim()
              ?.split(' ')
              ?.filter((y) => y.trim() != '')[7];

          const obj = {
            columnName: columnName,
            columnType: columnType,
            entityColumnType: this.getColumnType(columnType),
            entityColumnName: this.convertsnakeToCamel(columnName),
          };
          entityValues.push(obj);
        } else {
          const columnName = queries[index]
            ?.trim()
            ?.split(' ')
            ?.filter((y) => y.trim() != '')[2];
          const columnType = queries[index]
            ?.trim()
            ?.split(' ')
            ?.filter((y) => y.trim() != '')[4]
            ?.includes('(')
            ? queries[index]
              ?.trim()
              ?.split(' ')
              ?.filter((y) => y.trim() != '')[4]
              ?.substring(
                0,
                queries[index]
                  ?.trim()
                  ?.split(' ')
                  ?.filter((y) => y.trim() != '')[4]
                  .indexOf('('),
              )
            : queries[index]
              ?.trim()
              ?.split(' ')
              ?.filter((y) => y.trim() != '')[4];

          const obj = {
            columnName: columnName,
            columnType: columnType,
            entityColumnType: this.getColumnType(columnType),
            entityColumnName: this.convertsnakeToCamel(columnName),
          };
          entityValues.push(obj);
        }
      }
    } else {
      const queryItem = query.split(' ');

      const columnName = queryItem[5]?.trim();
      const columnType = queryItem[7]?.trim()?.includes('(')
        ? queryItem[7]?.trim()?.substring(0, queryItem[7]?.trim()?.indexOf('('))
        : queryItem[7]?.trim();

      const obj = {
        columnName: columnName,
        columnType: columnType,
        entityColumnType: this.getColumnType(columnType),
        entityColumnName: this.convertsnakeToCamel(columnName),
      };
      entityValues.push(obj);
    }

    return { tableName, entityValues };
  }

  updateExistingEntityForColumnRename(
    existingEntity: string,
    oldValue: string,
    newValue: string,
    newEntityColumnName: string,
    oldEntityColumnName: string,
  ) {
    let entityArr = existingEntity.split(';');

    const index = entityArr.findIndex((s) => s.includes(oldValue));
    const column = entityArr.find((s) => s.includes(oldValue));
    if (~index) {
      const firstPart = column.split('\n');

      for (let index = 0; index < firstPart.length; index++) {
        if (
          firstPart[index].includes(oldValue) &&
          firstPart[index].includes('@Column')
        ) {
          firstPart[index] = this.replaceValue(
            firstPart[index],
            oldValue,
            newValue,
          );
        }
        if (
          firstPart[index].includes(oldEntityColumnName) &&
          !firstPart[index].includes('@Column')
        ) {
          firstPart[index] = this.replaceValue(
            firstPart[index],
            oldEntityColumnName,
            newEntityColumnName,
          );
        }
      }
      const newColumn = firstPart.join('\n');

      entityArr[index] = newColumn;
    }
    const updatedEntity = entityArr.join(';');
    return updatedEntity;
  }

  private replaceValue(str, oldValue, newValue) {
    return str.replace(oldValue, newValue);
  }

  getEntityDetailsForRenameColumn(query: string) {
    const qArray = query
      ?.trim()
      ?.split(' ')
      ?.filter((y) => y.trim() != '');
    const tableName = qArray[2]?.trim();
    const oldColumnName = qArray[5]?.trim();
    const newColumnName = qArray[7]?.trim();
    const newEntityColumnName = this.convertsnakeToCamel(newColumnName);
    const oldEntityColumnName = this.convertsnakeToCamel(oldColumnName);

    return {
      tableName,
      oldColumnName,
      newColumnName,
      newEntityColumnName,
      oldEntityColumnName,
    };
  }

  updateExistingEntityFortypeChange(
    existingEntityContent: string,
    values: any,
  ) {
    let entityArr = existingEntityContent.split(';');
    let index = entityArr.findIndex((j) => j.includes(values.columnName));
    if (~index) {
      let newColumnTemplate = this.getNewColumn();

      newColumnTemplate = newColumnTemplate
        .replaceAll('{column_type}', values.columnType)
        .replaceAll('{column_name}', values.columnName)
        .replaceAll('{ entity_property }', values.entityColumnName)
        .replaceAll('{ entity_Property_type }', values.entityColumnType);

      newColumnTemplate += '\n\n';
      entityArr[index] = newColumnTemplate;
    }

    const updatedEntity = entityArr.join(';');
    return updatedEntity;
  }

  updateExistingEntityForDrop(
    existingEntityContent: string,
    columnName: string,
  ) {
    let entityArr = existingEntityContent.split(';');
    entityArr = entityArr.filter((j) => !j.includes(columnName));

    const updatedEntity = entityArr.join(';');
    return updatedEntity;
  }

  private async createNewCommit(octoGit, data: InputData[]) {
    const libraryCommit = await octoGit.repos.getCommit({
      owner: 'vs8871',
      ref: 'master',
      repo: 'entity-library',
    });

    const tree = await octoGit.git.getTree({
      owner: 'vs8871',
      repo: 'entity-library',
      tree_sha: libraryCommit?.data?.commit?.tree?.sha,
      recursive: '1',
    });

    let createTreeResponse;
    createTreeResponse = await octoGit.git.createTree({
      owner: 'vs8871',
      repo: 'entity-library',
      tree: this.getFileContent(data, tree),
    });

    const commitResponse = await octoGit.git.createCommit({
      owner: 'vs8871',
      repo: 'entity-library',
      message: `updated by autobot`,
      tree: createTreeResponse.data.sha,
      parents: [libraryCommit?.data?.sha],
    });

    const branchName = `refs/heads/entitybot/updated-code-${Date.now()}`;
    console.log(`creating new branch named ${branchName}`);

    await octoGit.git.createRef({
      owner: 'vs8871',
      repo: 'entity-library',
      ref: branchName,
      sha: commitResponse.data.sha,
    });

    console.log('branch created successfully');
  }

  private setEntityData(entityStr: any, tableName: string, data: InputData[], pathOfFile?: string) {
    const obj: InputData = {
      fileContent: entityStr,
      fileName: tableName.replaceAll('_', '-'),
      path: pathOfFile ? pathOfFile : `src/entity/${tableName.replaceAll('_', '-')}.entity.ts`,
    };
    data.push(obj);
  }

  private getEntityDetailsForAddColumn(query: string) {
    const entityValues: any[] = [];
    const tableName = query?.trim()?.split(' ')[2];
    if (query.includes(',')) {
      const queries = query.split(',');
      for (let index = 0; index < queries.length; index++) {
        if (queries[index]?.toLowerCase()?.includes('alter table')) {
          const columnName = queries[index]
            ?.trim()
            ?.split(' ')
            ?.filter((y) => y.trim() != '')[5];
          const columnType = queries[index]
            ?.trim()
            ?.split(' ')
            ?.filter((y) => y.trim() != '')[6]
            .includes('(')
            ? queries[index]
              ?.trim()
              ?.split(' ')
              ?.filter((y) => y.trim() != '')[6]
              .substring(
                0,
                queries[index]
                  ?.trim()
                  ?.split(' ')
                  ?.filter((y) => y.trim() != '')[6]
                  .indexOf('('),
              )
            : queries[index]
              ?.trim()
              ?.split(' ')
              ?.filter((y) => y.trim() != '')[6];

          const obj = {
            columnName: columnName,
            columnType: columnType,
            entityColumnType: this.getColumnType(columnType),
            entityColumnName: this.convertsnakeToCamel(columnName),
          };
          entityValues.push(obj);
        } else {
          const columnName = queries[index]
            ?.trim()
            ?.split(' ')
            ?.filter((y) => y.trim() != '')[2];
          const columnType = queries[index]
            ?.trim()
            ?.split(' ')
            ?.filter((y) => y.trim() != '')[3]
            .includes('(')
            ? queries[index]
              ?.trim()
              ?.split(' ')
              ?.filter((y) => y.trim() != '')[3]
              .substring(
                0,
                queries[index]
                  ?.trim()
                  ?.split(' ')
                  ?.filter((y) => y.trim() != '')[3]
                  .indexOf('('),
              )
            : queries[index]
              ?.trim()
              ?.split(' ')
              ?.filter((y) => y.trim() != '')[3];

          const obj = {
            columnName: columnName,
            columnType: columnType,
            entityColumnType: this.getColumnType(columnType),
            entityColumnName: this.convertsnakeToCamel(columnName),
          };
          entityValues.push(obj);
        }
      }
    } else {
      const queryItem = query.split(' ');

      const columnName = queryItem[5]?.trim();
      const columnType = queryItem[6]?.trim()?.includes('(')
        ? queryItem[6]?.trim()?.substring(0, queryItem[6]?.trim()?.indexOf('('))
        : queryItem[6]?.trim();

      const obj = {
        columnName: columnName,
        columnType: columnType,
        entityColumnType: this.getColumnType(columnType),
        entityColumnName: this.convertsnakeToCamel(columnName),
      };
      entityValues.push(obj);
    }
    return { tableName, entityValues };
  }

  private getEntityDetailsForDrop(query: string) {
    const entityValues: any[] = [];
    const tableName = query?.trim()?.split(' ')[2];
    if (query.includes(',')) {
      const queries = query?.trim()?.split(',');
      for (let index = 0; index < queries?.length; index++) {
        if (queries[index]?.toLowerCase()?.includes('alter table')) {
          const obj = {
            columnName: queries[index]
              ?.trim()
              ?.split(' ')
              ?.filter((y) => y.trim() != '')[5],
          };
          entityValues.push(obj);
        } else {
          const obj = {
            columnName: queries[index]
              ?.trim()
              ?.split(' ')
              ?.filter((y) => y.trim() != '')[2],
          };
          entityValues.push(obj);
        }
      }
    } else {
      const queryItem = query?.trim()?.split(' ');
      const obj = {
        columnName: queryItem[5]?.trim(),
      };
      entityValues.push(obj);
    }

    return { tableName, entityValues };
  }

  private async getExistingEntityDetails(octoGit: any, searchKey: string) {
    const files = await octoGit.search.code({
      q: `${searchKey} user:vs8871 repo:vs8871/entity-library`,
      mediaType: { format: 'text-match' },
    });
    const pathOfFile = files.data.items[0].path;
    const entityFileName = files.data.items[0].name;
    const fileSha = files.data.items[0].sha;
    return { pathOfFile, entityFileName, fileSha };
  }

  updateExistingEntity(
    existingEntityContent: string,
    columnName: string,
    columnType: string,
    entityColumnName: string,
    entityColumnType: string,
  ) {
    let entityToUpdate = existingEntityContent
      .trim()
      .substring(0, existingEntityContent.trim().length - 1);

    const newColumnTemplate = this.getNewColumn();
    entityToUpdate += '\r\n\r\n' + newColumnTemplate;

    entityToUpdate = entityToUpdate
      .replaceAll('{column_type}', columnType)
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
    const tableName = columnStr.substring(0, query.indexOf('(')).split(' ').pop();
    let entityClassName = this.convertsnakeToCamel(tableName);
    entityClassName = entityClassName.charAt(0).toUpperCase() + entityClassName.slice(1);
    let entityStr = entityTemplate;
    for (let index = 1; index < columns.length; index++) {
      const columnRow = columns[index].trim();
      const columnData = columnRow.split(' ')?.filter((y) => y.trim() != '');
      const entityColumnName = this.convertsnakeToCamel(columnData[0]);
      const entityColumnType = this.getColumnType(columnData[1]);
      const columnName = columnData[0];
      const columnType = columnData[1]?.toLowerCase();

      entityStr = entityStr
        .replaceAll('{column_type}', columnType)
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
    return str
      .toLowerCase()
      .replace(/([-_][a-z])/g, (group) =>
        group.toUpperCase().replace('-', '').replace('_', ''),
      );
  }

  getNewColumn() {
    return `    @Column({ type: '{column_type}', name: '{column_name}' })
    { entity_property }: { entity_Property_type };`;
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
        entityType = 'number';
        break;
      case 'bigint':
        entityType = 'number';
        break;
      case 'text':
      case 'varchar':
      case 'character varying':
        entityType = 'string';
        break;
      case 'timestamp':
        entityType = 'date';
        break;
      case 'boolean':
        entityType = 'boolean';
        break;
      case 'date':
        entityType = 'date';
        break;
      default:
        break;
    }
    return entityType;
  }

  private getFileContent(data: InputData[], tree: any) {
    let input: any[] = [];
    const deletedFilesPath: string[] = [];
    for (let index = 0; index < data.length; index++) {
      if (data[index]?.fileContent) {
        const obj = {
          path: data[index].path,
          content: data[index].fileContent,
          mode: '100644',
          type: 'blob',
        };
        input.push(obj);
      } else {
        deletedFilesPath.push(data[index].path);
      }
    }

    input.push(
      ...tree.data.tree.filter(
        (el) =>
          el.type !== 'tree' && !input.map((m) => m.path).includes(el.path),
      ),
    );
    if (deletedFilesPath?.length > 0) {
      input = input.filter((s) => !deletedFilesPath.includes(s.path));
    }
    return input;
  }
}
