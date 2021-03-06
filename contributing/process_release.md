# DO Release Process

## Release Artifacts
* Each DO release has several artifacts:
  * RPM
  * RPM sha256 checksum
  * Postman collection of examples
  * ASG Docker container
* RPM is built in every pipeline run, and is kept in GitLab for one week
* On a Git tag, RPM is published to Artifactory (f5-declarative-onboarding-rpm)

## Release Notes
* Release notes are tracked during development in RELEASE_NOTES.md

## Process for release candidates
* Update package.json and package-lock.json with version (X.Y.Z-#)
* mkdir schema/\<version\>
* cp src/schema/latest/* src/schema/\<version\>
* git add and commit
* git tag -m 'Release candidate X.Y.Z-#' vX.Y.Z-#
* git push origin
* git push origin --tags

## Process for release (assuming git remote 'github' points to GihHub)
* git tag -m 'Release X.Y.Z' vX.Y.Z
* git push
* git push --tags
* git checkout master
* git merge develop
* git push origin
* git push origin --tags
* git push github
* git push github --tags
* Download ASG artifact and expand it
* docker load --input <download_dir>/dist/f5devcentral-f5-do-container-X.Y.Z.tar.gz
* docker push f5devcentral/f5-do-container:X.Y.Z
* docker tag f5devcentral/f5-do-container:X.Y.Z f5devcentral/f5-do-container:latest
* docker push f5devcentral/f5-do-container:latest
