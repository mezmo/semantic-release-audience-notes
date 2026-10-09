library 'magic-butler-catalogue'

def PROJECT_NAME = "semantic-release-audience-notes"
def DEFAULT_BRANCH = 'main'
def TRIGGER_PATTERN = ".*@triggerbuild.*"
def BUILD_SLUG = slugify(env.BUILD_TAG)

def CURRENT_BRANCH = [env.CHANGE_BRANCH, env.BRANCH_NAME]?.find{branch -> branch != null}

def NPMRC = [
    configFile(fileId: 'npmrc', variable: 'NPM_CONFIG_USERCONFIG')
]

def RELEASE_CREDENTIALS = [
   usernamePassword(
     credentialsId: 'github-app-key-mezmo',
     passwordVariable: 'GITHUB_TOKEN',
     usernameVariable: 'GITHUB_APP'
   ),
   string(
     credentialsId: 'npm-publish-token',
     variable: 'NPM_TOKEN'
    )
]

pipeline {
  agent {
    node {
      label 'ec2-fleet-oss'
       customWorkspace("/tmp/workspace/${BUILD_SLUG}")
    }
  }

  options {
    timestamps()
    ansiColor 'xterm'
  }

  triggers {
    issueCommentTrigger(TRIGGER_PATTERN)
  }

  tools {
    nodejs 'NodeJS 24'
  }

  stages {
    stage('Setup') {
      steps {
        configFileProvider(NPMRC) {
          sh 'npm install'
        }
      }
    }

    stage('Lint') {
      stages{
        stage("CommitLint") {
          steps {
            // TODO: Add rich checks reporting
            sh 'npm run commitlint'
          }
          post {
            always {
              script {
                if (fileExists('.commitlint/report/checkstyle.json')) {
                  def report = readJSON file: '.commitlint/report/checkstyle.json'
                  publishChecks(
                    name: report.name,
                    title: report.title,
                    summary: report.summary,
                    text: report.text,
                    conclusion: report.conclusion,
                    status: 'COMPLETED',
                  )
                }
              }
            }
          }
        }

        stage("ESLint") {
          steps {
            discoverGitReferenceBuild()
            script {
              withChecks(name: 'eslint') {
                sh 'npm run lint:ci'
                recordIssues(
                  tool: esLint(pattern: '.eslint.json'),
                  id: 'eslint',
                  name: 'eslint',
                  sourceDirectories: [[path: "${WORKSPACE}"]],
                  checksAnnotationScope: 'ALL',
                  minimumSeverity: 'ERROR',
                  qualityGates: [[threshold: 1, type: 'TOTAL', criticality: 'FAILURE']],
                  stopBuild: true
                )
              }
            }
          }
        }
      }
    }

    stage('Test') {
      matrix {
        // One cell per Node major that package.json engines supports.
        axes {
          axis {
            name 'NODE_VERSION'
            values '22', '24'
          }
        }

        // Each cell gets its own agent and workspace, so the cells run in parallel
        // without sharing node_modules or tap's output.
        agent {
          node {
            label 'ec2-fleet-oss'
            customWorkspace("/tmp/workspace/${BUILD_SLUG}-node${NODE_VERSION}")
          }
        }

        stages {
          stage('Test on Node') {
            steps {
              nodejs(nodeJSInstallationName: "NodeJS ${NODE_VERSION}") {
                configFileProvider(NPMRC) {
                  sh 'npm install'
                }
                // The ESLint stage already linted. Tests run before knip so a knip
                // failure still leaves the coverage report the post step publishes.
                sh 'npm run test:ci'
              }
            }
            post {
              always {
                sh 'echo running post-test stage' // makes templating easier
                junit testResults: '.tap/test.xml', allowEmptyResults: true
                publishHTML target: [
                  allowMissing: false,
                  alwaysLinkToLastBuild: false,
                  keepAll: true,
                  reportDir: '.tap/report',
                  reportFiles: '*.html',
                  reportName: "coverage-node${NODE_VERSION}-${BUILD_SLUG}"
                ]
              }
            }
          }
        }
      }
    }

    stage('Release Test') {
      environment {
        GIT_BRANCH = "${CURRENT_BRANCH}"
        BRANCH_NAME = "${CURRENT_BRANCH}"
        CHANGE_ID = ""
        GITHUB_ACTION = 'yes'
      }

      // Runs with publish credentials, so never on a fork pull request, whose own
      // package.json decides what `release:dry` runs. A fork's branch is also absent
      // from this repository, which leaves semantic-release no branch to release.
      when {
        beforeAgent true
        not {
          branch DEFAULT_BRANCH
        }
        expression { return !env.CHANGE_FORK }
      }

      steps {
        sh 'npm install'
        withCredentials(RELEASE_CREDENTIALS) {
          sh 'npm run release:dry'
        }
      }
    }

    stage('Release') {
      environment {
        GIT_AUTHOR_NAME = 'Mezmo Bot'
        GIT_AUTHOR_EMAIL = 'bot@mezmo.com'
        GIT_COMMITTER_NAME = 'Mezmo Bot'
        GIT_COMMITTER_EMAIL = 'bot@mezmo.com'
        GITHUB_ACTION = 'yes'
      }
      when {
        beforeAgent true
        branch DEFAULT_BRANCH
        not {
          changelog '\\[skip ci\\]'
        }
      }

      steps {
        withCredentials(RELEASE_CREDENTIALS) {
          sh 'npm run release'
        }
      }
    }
  }
}
